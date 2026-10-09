import react from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [react()],
  // The `@/` alias from tsconfig.json, which Vite does not read on its own.
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    // Component tests need a DOM. Anything that does not can declare
    // `// @vitest-environment node` at the top of the file.
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: [
      "{app,components,lib}/**/*.test.{ts,tsx}",
      "test/**/*.test.{ts,tsx}",
    ],
    // e2e/ is Playwright's; running it here would load a different test runner's
    // globals and fail in a confusing way.
    exclude: ["node_modules/**", ".next/**", "e2e/**"],
  },
})
