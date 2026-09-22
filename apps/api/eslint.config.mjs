import { config } from "@patchgrid/eslint-config/base"
import { apiLayering, noRawSql, tenantCrossing } from "@patchgrid/eslint-config/boundaries"

/** @type {import("eslint").Linter.Config} */
export default [
  ...config,
  { files: ["src/**/*.ts"], ...apiLayering },
  { files: ["src/**/*.ts"], ...noRawSql },
  { files: ["src/**/*.ts"], ...tenantCrossing },
  { ignores: ["dist/**"] },
]
