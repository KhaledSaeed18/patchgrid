import path from "node:path"
import { minimatch } from "minimatch"

/**
 * `patchgrid/import-zones` — one rule, many boundaries.
 *
 * Why not `no-restricted-imports`? In a flat config, a later object that sets
 * the same rule REPLACES the earlier options for every file both match. Three
 * boundaries written as three `no-restricted-imports` objects with different
 * `ignores` therefore guard only the last one that applies to a file — which is
 * how a service importing Prisma linted clean while the rule banning it was
 * right there in the config. This rule takes every zone in a single options
 * object, so adding a boundary can never switch another one off.
 *
 * A zone names the files it covers (globs, relative to the linted package), the
 * files it exempts, and the imports it forbids — by package name (a subpath
 * counts) or by a regex over the import source. Globs match dot-segments, so a
 * relative `../../platform/run-as-tenant` is matched like any other path.
 */

const MATCH = { dot: true }

const matchesAny = (file, globs = []) => globs.some((glob) => minimatch(file, glob, MATCH))

function forbids(source, imports) {
  return imports.some((rule) =>
    "name" in rule
      ? source === rule.name || source.startsWith(`${rule.name}/`)
      : new RegExp(rule.regex).test(source),
  )
}

/** @type {import("eslint").Rule.RuleModule} */
export const importZones = {
  meta: {
    type: "problem",
    docs: { description: "Architectural import boundaries, as zones in one rule" },
    schema: [
      {
        type: "object",
        additionalProperties: false,
        required: ["zones"],
        properties: {
          zones: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["files", "imports", "message"],
              properties: {
                files: { type: "array", items: { type: "string" } },
                except: { type: "array", items: { type: "string" } },
                imports: {
                  type: "array",
                  items: {
                    oneOf: [
                      {
                        type: "object",
                        additionalProperties: false,
                        required: ["name"],
                        properties: { name: { type: "string" } },
                      },
                      {
                        type: "object",
                        additionalProperties: false,
                        required: ["regex"],
                        properties: { regex: { type: "string" } },
                      },
                    ],
                  },
                },
                message: { type: "string" },
              },
            },
          },
        },
      },
    ],
    messages: { forbidden: "'{{source}}' may not be imported here. {{message}}" },
  },

  create(context) {
    const file = path.isAbsolute(context.filename)
      ? path.relative(context.cwd, context.filename)
      : context.filename
    const posix = file.split(path.sep).join("/")

    const zones = context.options[0].zones.filter(
      (zone) => matchesAny(posix, zone.files) && !matchesAny(posix, zone.except),
    )
    if (zones.length === 0) return {}

    const check = (node, source) => {
      if (typeof source !== "string") return
      for (const zone of zones) {
        if (forbids(source, zone.imports)) {
          context.report({ node, messageId: "forbidden", data: { source, message: zone.message } })
          return
        }
      }
    }

    return {
      ImportDeclaration: (node) => check(node, node.source.value),
      ExportNamedDeclaration: (node) => node.source && check(node, node.source.value),
      ExportAllDeclaration: (node) => check(node, node.source.value),
      ImportExpression: (node) =>
        node.source.type === "Literal" && check(node, node.source.value),
      "CallExpression[callee.name='require']": (node) => {
        const [argument] = node.arguments
        if (argument?.type === "Literal") check(node, argument.value)
      },
    }
  },
}

export const plugin = { rules: { "import-zones": importZones } }
