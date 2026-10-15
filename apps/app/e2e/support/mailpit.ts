import { expect, type APIRequestContext } from "@playwright/test"

import { MAILPIT_URL } from "./stack"

type Summary = { ID: string; Subject: string; Created: string }

/**
 * The inbox the stack delivers to. Mail goes through a queue, so the link a
 * flow is waiting for arrives a moment after the action; polled, never slept.
 */
export async function linkInMailTo(
  request: APIRequestContext,
  to: string,
  subject: RegExp,
  href: RegExp,
  notBefore: Date
): Promise<string> {
  let found = ""
  await expect
    .poll(
      async () => {
        const list = await request.get(
          `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}&limit=20`
        )
        const { messages } = (await list.json()) as { messages: Summary[] }
        const match = messages.find(
          (m) =>
            subject.test(m.Subject) &&
            new Date(m.Created).getTime() >= notBefore.getTime() - 5_000
        )
        if (match === undefined) return null
        const message = await request.get(
          `${MAILPIT_URL}/api/v1/message/${match.ID}`
        )
        const { Text } = (await message.json()) as { Text: string }
        found = Text.match(href)?.[0] ?? ""
        return found === "" ? null : found
      },
      {
        timeout: 30_000,
        message: `no mail to ${to} matching ${String(subject)}`,
      }
    )
    .not.toBeNull()
  return found
}
