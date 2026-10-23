import type { AttachmentMimeType } from "@patchgrid/contracts"

/** How many leading bytes `sniff` wants: enough for every signature and a fair look at text. */
export const SNIFF_BYTES = 4096

const ZIP_CONTAINERS: ReadonlySet<AttachmentMimeType> = new Set([
  "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
])
const OLE_CONTAINERS: ReadonlySet<AttachmentMimeType> = new Set(["application/msword", "application/vnd.ms-excel"])
const TEXT: ReadonlySet<AttachmentMimeType> = new Set(["text/plain", "text/csv", "application/json"])

/** Markup a browser would render as a document — never accepted as "text", whatever it is called. */
const MARKUP = /^\s*<(?:!doctype|html|head|body|svg|\?xml|script|iframe|object|embed|meta|link|style)\b/i

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0) => signature.every((byte, i) => bytes[at + i] === byte)
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0))

/**
 * What a file really is, judged by its first bytes (ADR-0005): the type the
 * browser declared when the bytes agree with it, otherwise `null` and the
 * upload is refused. A declared type is never taken on trust — a PNG must
 * start like a PNG — and text must be text: UTF-8, no NUL bytes, and nothing
 * that opens like a page a browser would render.
 */
export function sniff(bytes: Uint8Array, declared: AttachmentMimeType): AttachmentMimeType | null {
  const found = signatureOf(bytes)
  if (found !== null) {
    if (found === declared) return declared
    if (found === "application/zip" && ZIP_CONTAINERS.has(declared)) return declared
    if (found === "application/msword" && OLE_CONTAINERS.has(declared)) return declared
    return null
  }
  return TEXT.has(declared) && isPlainText(bytes) ? declared : null
}

function signatureOf(bytes: Uint8Array): AttachmentMimeType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif"
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp"
  if (startsWith(bytes, ascii("%PDF-"))) return "application/pdf"
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "application/zip"
  // The OLE compound file every pre-2007 Office document is.
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "application/msword"
  return null
}

function isPlainText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false
  let text: string
  try {
    // A sample may end mid-character; only the cut at the very end is forgiven.
    text = new TextDecoder("utf-8", { fatal: true }).decode(trimPartial(bytes))
  } catch {
    return false
  }
  return !MARKUP.test(text.replace(/^\uFEFF/, ""))
}

/** Drops an incomplete UTF-8 sequence at the end of a sample. */
function trimPartial(bytes: Uint8Array): Uint8Array {
  for (let back = 1; back <= 3 && back <= bytes.length; back += 1) {
    const byte = bytes[bytes.length - back] ?? 0
    if ((byte & 0xc0) === 0x80) continue
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
    return need > back ? bytes.subarray(0, bytes.length - back) : bytes
  }
  return bytes
}
