import { nextJsConfig } from "@patchgrid/eslint-config/next-js"
import { noDatabaseInFrontend } from "@patchgrid/eslint-config/boundaries"

/** @type {import("eslint").Linter.Config} */
export default [...nextJsConfig, { files: ["**/*.{ts,tsx}"], ...noDatabaseInFrontend }]
