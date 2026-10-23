import path from "node:path"

import createMDX from "@next/mdx"
import { STRICT_TRANSPORT_SECURITY } from "@patchgrid/contracts"
import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: ["@patchgrid/ui", "@patchgrid/contracts"],
  // The production image runs the traced, self-contained server (docker/next.Dockerfile).
  // Tracing starts at the monorepo root, or the workspace packages are left out.
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  // Every page is a prerendered shell; only the header's account links read the
  // request, and they stream in behind it.
  cacheComponents: true,
  partialPrefetching: true,
  // `experimental.inlineCss` is off. It saved the stylesheet's round trip, but
  // under cacheComponents the 94 KB stylesheet went out four times per page —
  // once as <style>, three times inside the flight payload — making the home
  // page 443 KB (82 KB gzipped) where it is now 55 KB (14 KB). Lighthouse's
  // mobile LCP fell from ~3.4 s to ~2.9 s with it.
  // The repository's CLAUDE.md already says to read node_modules/next/dist/docs;
  // a generated copy per app would only drift from it.
  agentRules: false,
  // Development serves the apex as lvh.me; without this the dev server refuses
  // its own scripts there and nothing hydrates.
  allowedDevOrigins: ["lvh.me"],
  // HSTS whenever the build is for HTTPS (DNS.md §HSTS, ADR-0058). Development
  // is plain HTTP on lvh.me, where the header would be ignored anyway.
  async headers() {
    if (process.env.NEXT_PUBLIC_PROTOCOL !== "https") return []
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: STRICT_TRANSPORT_SECURITY,
          },
        ],
      },
    ]
  },
}

// The docs and the blog are MDX in the repository (ADR-0016). Plugins are named
// as strings: Turbopack cannot take functions across into Rust.
const withMDX = createMDX({ options: { remarkPlugins: ["remark-gfm"] } })

export default withMDX(nextConfig)
