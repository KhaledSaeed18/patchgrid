import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // No DOM: this site's own logic is data, and its components are thin enough
    // that rendering them would test React rather than us.
    environment: "node",
    include: ["{app,lib}/**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
  },
})
