import path from "node:path"

import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: ["@patchgrid/ui", "@patchgrid/contracts"],
  // The production image runs the traced, self-contained server (docker/next.Dockerfile).
  // Tracing starts at the monorepo root, or the workspace packages are left out.
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  // Development serves every workspace from <slug>.lvh.me; without this the dev
  // server refuses its own scripts and HMR to those hosts, and nothing hydrates.
  allowedDevOrigins: ["*.lvh.me"],
  // The repository's CLAUDE.md already says to read node_modules/next/dist/docs;
  // a generated copy per app would only drift from it.
  agentRules: false,
}

export default nextConfig
