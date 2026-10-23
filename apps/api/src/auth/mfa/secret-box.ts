import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

/**
 * A second factor's secret at rest (ADR-0029): AES-256-GCM under a key kept
 * apart from the database. `v1.<iv>.<tag>.<ciphertext>`, base64url each, so a
 * future key or cipher is a new version rather than a guess.
 */
export class SecretBox {
  private readonly key: Buffer

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, "base64")
    if (this.key.length !== 32) throw new Error("SecretBox needs a 32-byte key")
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", this.key, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
    return ["v1", iv, cipher.getAuthTag(), ciphertext]
      .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
      .join(".")
  }

  /** `null` for anything tampered with, truncated, or sealed under another key. */
  open(sealed: string): string | null {
    const [version, iv, tag, ciphertext] = sealed.split(".")
    if (version !== "v1" || iv === undefined || tag === undefined || ciphertext === undefined) return null
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"))
      decipher.setAuthTag(Buffer.from(tag, "base64url"))
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8")
    } catch {
      return null
    }
  }
}
