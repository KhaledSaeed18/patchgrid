import type { ReactNode } from "react"

/**
 * One frame for every message. Table layout and inline styles, because mail
 * clients render roughly what browsers rendered in 2005. The accent is the
 * Tangerine theme's primary; everything else is neutral on purpose.
 */
export function MailLayout({ preview, children }: { preview: string; children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width" />
        <title>{preview}</title>
      </head>
      <body style={{ margin: 0, padding: 0, backgroundColor: "#f6f4f1", fontFamily: "'Open Sans', Helvetica, Arial, sans-serif", color: "#1f1d1a" }}>
        <div style={{ display: "none", maxHeight: 0, overflow: "hidden" }}>{preview}</div>
        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={{ padding: "32px 16px" }}>
          <tbody>
            <tr>
              <td align="center">
                <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={{ maxWidth: 560, backgroundColor: "#ffffff", borderRadius: 4, border: "1px solid #e6e1da" }}>
                  <tbody>
                    <tr>
                      <td style={{ padding: "24px 32px 0", fontSize: 18, fontWeight: 600, color: "#e86a1a" }}>Patchgrid</td>
                    </tr>
                    <tr>
                      <td style={{ padding: "16px 32px 32px", fontSize: 15, lineHeight: "24px" }}>{children}</td>
                    </tr>
                  </tbody>
                </table>
                <p style={{ maxWidth: 560, margin: "16px auto 0", fontSize: 12, lineHeight: "18px", color: "#7a736b" }}>
                  You received this because an action was taken on Patchgrid with this address. If it was not you, you can ignore this message.
                </p>
              </td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
  )
}

export function Button({ href, children }: { href: string; children: ReactNode }) {
  return (
    <p style={{ margin: "24px 0" }}>
      <a
        href={href}
        style={{ display: "inline-block", padding: "12px 20px", backgroundColor: "#e86a1a", color: "#ffffff", textDecoration: "none", borderRadius: 4, fontWeight: 600 }}
      >
        {children}
      </a>
    </p>
  )
}

/** The link in full, for clients that strip buttons and for copy-paste. */
export function FallbackLink({ href }: { href: string }) {
  return (
    <p style={{ fontSize: 13, color: "#7a736b", wordBreak: "break-all" }}>
      Or paste this link into your browser: <a href={href} style={{ color: "#e86a1a" }}>{href}</a>
    </p>
  )
}
