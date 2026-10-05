import swc from "unplugin-swc"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Unit only. Integration specs under test/ need a database and run through
    // vitest.integration.config.ts.
    include: ["src/**/*.spec.ts"],
    globals: false,
  },
  // Nest's DI reads design-time type metadata that only a decorator-aware
  // transform emits. Vitest's default esbuild transform does not (ADR-0011).
  plugins: [swc.vite({ module: { type: "es6" } })],
})
