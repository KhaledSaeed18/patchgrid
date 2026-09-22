/**
 * Conventional Commits, enforced (`ENGINEERING.md` §Repository hygiene).
 *
 * A convention nothing checks is a suggestion, and the commit log is the only
 * part of this repository that cannot be reformatted later.
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Scopes are the deployables and packages, so `git log --grep` is useful and
    // a typo'd scope is caught rather than silently creating a new one.
    "scope-enum": [
      2,
      "always",
      [
        // deployables
        "api",
        "app",
        "www",
        // packages
        "db",
        "contracts",
        "ui",
        "ts",
        "lint",
        // cross-cutting
        "config",
        "deps",
        "ci",
        "docs",
        "agents",
        "test",
        "security",
      ],
    ],
    "scope-case": [2, "always", "kebab-case"],
    "subject-case": [2, "always", "lower-case"],
    "header-max-length": [2, "always", 100],
    "body-max-line-length": [2, "always", 100],
  },
}
