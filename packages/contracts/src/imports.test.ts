import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))

/** Each module's sibling imports, by file name. */
function graph(): Map<string, string[]> {
  const files = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  return new Map(files.map((f) => [f, [...readFileSync(join(here, f), "utf8").matchAll(/from "\.\/([\w-]+\.ts)"/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]))]))
}

describe("the contracts' imports", () => {
  it("form no cycle: a schema built while its dependency is half-loaded holds `undefined` and fails only at runtime", () => {
    const edges = graph()
    const cycles: string[] = []
    const walk = (file: string, path: string[]): void => {
      if (path.includes(file)) {
        cycles.push([...path.slice(path.indexOf(file)), file].join(" → "))
        return
      }
      for (const next of edges.get(file) ?? []) walk(next, [...path, file])
    }
    for (const file of edges.keys()) walk(file, [])
    expect([...new Set(cycles)]).toEqual([])
  })
})
