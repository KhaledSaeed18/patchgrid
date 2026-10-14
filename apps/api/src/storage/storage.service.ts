import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { Injectable } from "@nestjs/common"

import { type AppConfig, InjectConfig } from "../config/app-config"

/** A presigned PUT: the URL, and the headers the browser must send with it exactly. */
export type PresignedPut = { url: string; headers: Record<string, string>; expiresAt: Date }

/**
 * Object storage (ADR-0005, ADR-0037): the integration boundary for
 * attachment bytes. S3 in production, MinIO locally; nothing above knows
 * which. Two clients on purpose: one talks to storage from inside the
 * network (head, read, delete), the other only signs URLs for browsers, on
 * the files origin — its own registrable domain — because the host is part
 * of the signature. The API never holds a file's bytes beyond the few it
 * reads to sniff.
 */
@Injectable()
export class StorageService {
  private readonly internal: S3Client
  private readonly signer: S3Client
  private readonly bucket: string

  constructor(@InjectConfig() config: AppConfig) {
    const credentials = { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY }
    const common = { region: config.S3_REGION, credentials, forcePathStyle: true }
    this.internal = new S3Client({ ...common, endpoint: config.S3_ENDPOINT })
    this.signer = new S3Client({ ...common, endpoint: config.FILES_PUBLIC_ORIGIN })
    this.bucket = config.S3_BUCKET
  }

  /** One upload of exactly this type and length (ADR-0005 erratum: exact, not a range). */
  async presignPut(key: string, contentType: string, contentLength: number, ttlSeconds: number, now: Date): Promise<PresignedPut> {
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: contentLength })
    const url = await getSignedUrl(this.signer, command, { expiresIn: ttlSeconds, signableHeaders: new Set(["content-type", "content-length"]) })
    return {
      url,
      headers: { "Content-Type": contentType },
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
    }
  }

  /** A short-lived download, served as the sniffed type with the disposition chosen by the caller. */
  async presignGet(
    key: string,
    serve: { filename: string; contentType: string; inline: boolean },
    ttlSeconds: number,
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentType: serve.contentType,
      ResponseContentDisposition: contentDisposition(serve.inline ? "inline" : "attachment", serve.filename),
      ResponseCacheControl: "private, no-store",
    })
    return getSignedUrl(this.signer, command, { expiresIn: ttlSeconds })
  }

  /** The stored size, or `null` when nothing was uploaded. */
  async size(key: string): Promise<number | null> {
    try {
      const head = await this.internal.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return head.ContentLength ?? null
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  /** The first `length` bytes — what sniffing reads. */
  async readStart(key: string, length: number): Promise<Uint8Array> {
    const object = await this.internal.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${String(length - 1)}` }))
    return object.Body === undefined ? new Uint8Array() : object.Body.transformToByteArray()
  }

  /** Bytes the API itself received — an emailed file (ADR-0027 §7), a stored message. */
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.internal.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: contentType, ContentLength: bytes.length }))
  }

  /** A whole object — a stored inbound message, never a user's download. `null` when it is not there. */
  async read(key: string): Promise<Uint8Array | null> {
    try {
      const object = await this.internal.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      return object.Body === undefined ? new Uint8Array() : await object.Body.transformToByteArray()
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  /** A server-side copy: the bytes never pass through the API. */
  async copy(from: string, to: string): Promise<void> {
    await this.internal.send(
      new CopyObjectCommand({ Bucket: this.bucket, Key: to, CopySource: `${this.bucket}/${from.split("/").map(encodeURIComponent).join("/")}` }),
    )
  }

  /** Idempotent: deleting what is not there is not an error. */
  async remove(key: string): Promise<void> {
    await this.internal.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }
}

/** RFC 6266: an ASCII fallback and the exact name in RFC 5987 form. */
export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_")
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const meta = (error as { $metadata?: { httpStatusCode?: number }; name?: string })
  return meta.$metadata?.httpStatusCode === 404 || meta.name === "NotFound" || meta.name === "NoSuchKey"
}
