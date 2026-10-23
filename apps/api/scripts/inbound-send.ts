/**
 * The dev harness for email intake (FEATURES.md M6): build a message the way
 * the receiving MTA would hand it over, sign it, and post it to the local API.
 *
 *   pnpm --filter @patchgrid/api run inbound:send -- --from rita@patchgrid.test --to acme \
 *     --subject "Printer on floor 3" --text "It says offline again." [--dmarc fail] \
 *     [--in-reply-to "<t.…@inbound.lvh.me>"] [--attach ./log.txt] [--header "Auto-Submitted: auto-replied"]
 *
 * Reads INBOUND_WEBHOOK_SECRET, INBOUND_AUTHSERV_ID and ROOT_DOMAIN from the repository `.env`.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

import { buildMessage, webhookRequest } from "../test/support/inbound-mail.ts"

try {
  process.loadEnvFile(path.join(__dirname, "../../../.env"))
} catch {
  // the environment supplies them
}

// `pnpm run inbound:send -- --from …` passes the `--` through; it is not an argument.
const args = process.argv.slice(2)
const { values } = parseArgs({
  args: args[0] === "--" ? args.slice(1) : args,
  options: {
    from: { type: "string", default: "rita@patchgrid.test" },
    to: { type: "string", default: "acme" },
    subject: { type: "string", default: "Printer on floor 3 says offline" },
    text: { type: "string", default: "It shows offline from every laptop, but the panel says ready." },
    dmarc: { type: "string", default: "pass" },
    "in-reply-to": { type: "string" },
    attach: { type: "string", multiple: true },
    header: { type: "string", multiple: true },
    api: { type: "string", default: "http://api.lvh.me:4000" },
  },
})

const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === "") throw new Error(`${name} is not set; see .env.example`)
  return value
}

const root = process.env.ROOT_DOMAIN ?? "lvh.me"
const to = values.to.includes("@") ? values.to : `${values.to}@inbound.${root}`
const dmarc = values.dmarc === "fail" || values.dmarc === "none" ? values.dmarc : "pass"
const headers = Object.fromEntries(
  (values.header ?? []).map((h) => {
    const at = h.indexOf(":")
    return [h.slice(0, at).trim(), h.slice(at + 1).trim()]
  }),
)
const raw = buildMessage({
  from: values.from,
  to,
  subject: values.subject,
  text: values.text,
  dmarc,
  authservId: required("INBOUND_AUTHSERV_ID"),
  ...(values["in-reply-to"] === undefined ? {} : { inReplyTo: values["in-reply-to"] }),
  headers,
  attachments: (values.attach ?? []).map((file) => ({
    filename: path.basename(file),
    contentType: file.endsWith(".png") ? "image/png" : file.endsWith(".pdf") ? "application/pdf" : "text/plain",
    content: readFileSync(file),
  })),
})
async function main(): Promise<void> {
  const request = webhookRequest(required("INBOUND_WEBHOOK_SECRET"), [to], raw)
  const response = await fetch(`${values.api}/api/v1/inbound/email`, { method: "POST", headers: request.headers, body: request.body })
  console.log(`${String(response.status)} ${await response.text()}`)
  console.log(
    `sent "${values.subject}" from ${values.from} to ${to} (dmarc=${dmarc}); the job settles it in a moment — see Settings → Inbound email.`,
  )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
