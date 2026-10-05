import { config } from "@patchgrid/eslint-config/base"
import { apiBoundaries, noRawSql } from "@patchgrid/eslint-config/boundaries"

/** @type {import("eslint").Linter.Config} */
export default [
  ...config,
  { files: ["src/**/*.ts"], ...apiBoundaries },
  { files: ["src/**/*.ts"], ...noRawSql },
  { ignores: ["dist/**"] },
]
