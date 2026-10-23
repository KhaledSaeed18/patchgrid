/** The line our ticket mail puts above its own text, so a reply can be cut from what it quotes. */
export const REPLY_ABOVE_LINE = "— Reply above this line to add to the ticket —"

const QUOTE_HEADERS = [/^on .{1,300}wrote:\s*$/i, /^-{2,}\s*original message\s*-{2,}\s*$/i, /^_{10,}\s*$/, /^from:\s.+$/i]

/**
 * What a person wrote in a reply, without what they quoted (DOMAIN.md §7):
 * cut at our marker, at the first quote header (`On … wrote:`, Outlook's
 * separator), at a signature delimiter, and drop `>` lines. Falls back to
 * the whole text when cutting would leave nothing.
 */
export function replyText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  const kept: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === REPLY_ABOVE_LINE || trimmed === "-- " || line === "-- ") break
    if (QUOTE_HEADERS.some((pattern) => pattern.test(trimmed))) break
    if (trimmed.startsWith(">")) continue
    kept.push(line)
  }
  const reply = kept.join("\n").trim()
  return reply === "" ? text.trim() : reply
}
