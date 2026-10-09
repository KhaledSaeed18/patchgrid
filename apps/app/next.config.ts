import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: ["@patchgrid/ui", "@patchgrid/contracts"],
}

export default nextConfig
