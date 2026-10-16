import { readFile } from "node:fs/promises"
import path from "node:path"

import { ImageResponse } from "next/og"

/**
 * The card a link to this site unfurls into. Every Open Graph image is drawn
 * here, at build time — none reads the request — in the site's serif (Source
 * Serif 4, OFL, vendored: the renderer needs a static TrueType file, not the web
 * font) and the theme's light palette, written out because the renderer has no
 * CSS variables.
 */
export const OG_SIZE = { width: 1200, height: 630 }
export const OG_TYPE = "image/png"

const COLOURS = {
  background: "#e8ebed",
  foreground: "#333333",
  muted: "#5f6674",
  primary: "#cb4a24",
}

// Read at module load, before any image is asked for: a read awaited inside the
// handler is request-time I/O to the prerenderer, and the image went dynamic.
const serif = await readFile(path.join(process.cwd(), "assets/fonts/SourceSerif4-Semibold.ttf"))

/** The priority grid from the landing page, in miniature: urgency across, impact down. */
const GRID = [
  [0.25, 0.45, 0.7],
  [0.45, 0.7, 0.85],
  [0.7, 0.85, 1],
]

export async function ogImage({ eyebrow, title }: { eyebrow: string; title: string }): Promise<ImageResponse> {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background: COLOURS.background,
          color: COLOURS.foreground,
          fontFamily: "Source Serif",
          borderLeft: `16px solid ${COLOURS.primary}`,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <span style={{ fontSize: 34 }}>Patchgrid</span>
            <span style={{ fontSize: 28, color: COLOURS.muted }}>{eyebrow}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {GRID.map((row, r) => (
              <div key={r} style={{ display: "flex", gap: 8 }}>
                {row.map((strength, c) => (
                  <div
                    key={c}
                    style={{ width: 36, height: 36, borderRadius: 6, background: COLOURS.primary, opacity: strength }}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", fontSize: title.length > 36 ? 68 : 84, lineHeight: 1.1, maxWidth: 980 }}>
          {title}
        </div>
        <span style={{ fontSize: 26, color: COLOURS.muted }}>patchgrid.xyz</span>
      </div>
    ),
    { ...OG_SIZE, fonts: [{ name: "Source Serif", data: serif, weight: 600, style: "normal" }] },
  )
}
