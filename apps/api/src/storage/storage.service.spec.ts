import { describe, expect, it } from "vitest"

import type { AppConfig } from "../config/app-config"
import { contentDisposition, StorageService } from "./storage.service"

const config = {
  S3_ENDPOINT: "http://minio:9000",
  FILES_PUBLIC_ORIGIN: "https://patchgrid-files.net",
  S3_REGION: "us-east-1",
  S3_BUCKET: "patchgrid-attachments",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
} as AppConfig

describe("StorageService", () => {
  it("signs uploads and downloads for the files origin, never the internal endpoint (ADR-0037)", async () => {
    const storage = new StorageService(config)
    const put = await storage.presignPut("org/o/tickets/t/x-log.txt", "text/plain", 42, 300, new Date(0))
    expect(new URL(put.url).origin).toBe("https://patchgrid-files.net")
    expect(put.url).toContain("X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost")
    expect(put.expiresAt).toEqual(new Date(300_000))
    const get = new URL(await storage.presignGet("org/o/tickets/t/x-log.txt", { filename: "log.txt", contentType: "text/plain", inline: false }, 120))
    expect(get.origin).toBe("https://patchgrid-files.net")
    expect(get.searchParams.get("response-content-disposition")).toMatch(/^attachment; /)
    expect(get.searchParams.get("response-content-type")).toBe("text/plain")
  })

  it("names a file safely in Content-Disposition, whatever its characters", () => {
    expect(contentDisposition("attachment", "report.pdf")).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`)
    expect(contentDisposition("attachment", 'a"b\\c é.txt')).toBe(`attachment; filename="a_b_c _.txt"; filename*=UTF-8''a%22b%5Cc%20%C3%A9.txt`)
  })
})
