import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: ["@patchgrid/ui", "@patchgrid/contracts"],
  // Development serves every workspace from <slug>.lvh.me; without this the dev
  // server refuses its own scripts and HMR to those hosts, and nothing hydrates.
  allowedDevOrigins: ["*.lvh.me"],
}

export default nextConfig
