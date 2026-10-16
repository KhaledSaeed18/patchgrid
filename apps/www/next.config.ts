import createMDX from "@next/mdx"
import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: ["@patchgrid/ui", "@patchgrid/contracts"],
  // Every page is a prerendered shell; only the header's account links read the
  // request, and they stream in behind it.
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    // Most visitors arrive once, from a search or a link: the stylesheet in the
    // first response saves a render-blocking round trip, and later pages are
    // client navigations that never fetch it again.
    inlineCss: true,
  },
  // The repository's CLAUDE.md already says to read node_modules/next/dist/docs;
  // a generated copy per app would only drift from it.
  agentRules: false,
  // Development serves the apex as lvh.me; without this the dev server refuses
  // its own scripts there and nothing hydrates.
  allowedDevOrigins: ["lvh.me"],
}

// The docs and the blog are MDX in the repository (ADR-0016). Plugins are named
// as strings: Turbopack cannot take functions across into Rust.
const withMDX = createMDX({ options: { remarkPlugins: ["remark-gfm"] } })

export default withMDX(nextConfig)
