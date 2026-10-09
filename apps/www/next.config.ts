import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: ["@patchgrid/ui", "@patchgrid/contracts"],
  // The repository's CLAUDE.md already says to read node_modules/next/dist/docs;
  // a generated copy per app would only drift from it.
  agentRules: false,
  // Development serves the apex as lvh.me; without this the dev server refuses
  // its own scripts there and nothing hydrates.
  allowedDevOrigins: ["lvh.me"],
}

export default nextConfig
