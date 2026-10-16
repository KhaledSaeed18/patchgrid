import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

export default defineConfig({
  // The `@/` alias from tsconfig.json, which Vite does not read on its own.
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    // No DOM: this site's own logic is data, and its components are thin enough
    // that rendering them would test React rather than us.
    environment: "node",
    include: ["{app,lib}/**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
  },
})
