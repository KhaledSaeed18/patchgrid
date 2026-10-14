import type { AuthVerdict } from "@patchgrid/contracts"

/**
 * The verdict on a message (ADR-0039): the topmost `Authentication-Results`
 * whose authserv-id is our receiving MTA's — any other is the sender's own
 * claim (RFC 8601 §5) — and in it a DMARC pass whose `header.from` is the
 * `From:` domain. `headers` are the header values, top of the message first.
 */
export function verdictFrom(headers: readonly string[], authservId: string, fromAddress: string): AuthVerdict {
  const trusted = headers.map(withoutComments).find((value) => authservIdOf(value) === authservId.toLowerCase())
  if (trusted === undefined) return "NONE"
  const dmarc = trusted
    .split(";")
    .slice(1)
    .map((part) => part.trim())
    .find((part) => /^dmarc\s*=/i.test(part))
  if (dmarc === undefined) return "NONE"
  const result = /^dmarc\s*=\s*([a-z]+)/i.exec(dmarc)?.[1]?.toLowerCase()
  const headerFrom = /\bheader\.from\s*=\s*"?([^\s;"]+)"?/i.exec(dmarc)?.[1]?.toLowerCase()
  const fromDomain = fromAddress.toLowerCase().split("@").at(-1)
  return result === "pass" && headerFrom !== undefined && headerFrom === fromDomain ? "PASS" : "FAIL"
}

/** `mx.example.com 1; spf=…` → `mx.example.com` (an optional version follows the id). */
function authservIdOf(value: string): string {
  return (value.split(";")[0] ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? ""
}

/** RFC 8601 allows CFWS anywhere; a parenthesised comment could otherwise smuggle `dmarc=pass`. */
function withoutComments(value: string): string {
  let out = value.replace(/\r?\n[ \t]+/g, " ")
  // Nested comments: strip the innermost until none remain.
  for (let previous = ""; previous !== out; ) {
    previous = out
    out = out.replace(/\([^()]*\)/g, " ")
  }
  return out
}
