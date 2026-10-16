import { isValidElement, type ReactNode } from "react"

/** The words in a heading, however MDX nested them (`## The \`version\` field`). */
export function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children)
  return ""
}

/** A heading's anchor: "Who can approve a change?" → `who-can-approve-a-change`. */
export const anchorFor = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
