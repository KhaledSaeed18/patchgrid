import js from "@eslint/js"
import eslintConfigPrettier from "eslint-config-prettier"
import turboPlugin from "eslint-plugin-turbo"
import tseslint from "typescript-eslint"

/**
 * A shared ESLint configuration for the repository.
 *
 * Note the absence of `eslint-plugin-only-warn`, which the scaffold shipped with:
 * it downgrades every error to a warning, and ESLint exits 0 on warnings. That
 * makes the CI lint job pass regardless of what it finds — and the architectural
 * boundary rules in `./boundaries.js` are exactly the kind of thing that must be
 * able to fail a build. Lint runs with `--max-warnings 0` so nothing accumulates.
 *
 * @type {import("eslint").Linter.Config}
 * */
export const config = [
  js.configs.recommended,
  eslintConfigPrettier,
  ...tseslint.configs.recommended,
  {
    plugins: {
      turbo: turboPlugin,
    },
    rules: {
      "turbo/no-undeclared-env-vars": "warn",
    },
  },
  {
    ignores: ["dist/**", ".next/**", "**/.turbo/**", "**/coverage/**"],
  },
]
