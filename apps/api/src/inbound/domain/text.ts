/**
 * Text a message carries, made safe to store: Postgres `text` refuses NUL,
 * and a stray control character or half a surrogate pair is no use to a
 * reader. Tabs and newlines stay.
 */
export function storableText(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- removing control characters is the point
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
  )
}

/** At most `limit` characters, never cutting a character in two. */
export function truncate(text: string, limit: number): string {
  const chars = Array.from(text)
  return chars.length <= limit ? text : chars.slice(0, limit).join("")
}
