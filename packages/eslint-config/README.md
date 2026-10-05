# `@patchgrid/eslint-config`

Shared ESLint configuration for the workspace.

| Export            | What it is                                                                   |
| ----------------- | ---------------------------------------------------------------------------- |
| `./base`          | Recommended JS + TypeScript rules, Prettier compatibility, turbo env checks   |
| `./next-js`       | `base` plus React and Next.js rules                                          |
| `./react-internal`| `base` plus React rules for component packages                               |
| `./boundaries`    | The architectural boundaries from `CLAUDE.md`, as lint rules                 |

## Boundaries

The API's import boundaries — repositories are the only Prisma importers, the
crossing helpers are importable only by named modules, the request context is
written only by the modules that own it — are **zones of one custom rule**,
`patchgrid/import-zones` (`rules/import-zones.js`), configured in a single
object (`apiBoundaries`).

They are not several `no-restricted-imports` objects, and this is the thing to
know before adding one: in a flat config, a later object that configures the
same rule **replaces** the earlier options for every file both match. Written
that way, only the last boundary that applied to a file was enforced, and a
service importing Prisma linted clean.

Every zone is proven in `boundaries.test.js` by the violation it names and by
the module allowed to make it. A new boundary adds a zone to `API_ZONES` and a
pair of cases there; `pnpm --filter @patchgrid/eslint-config run test` runs them.
