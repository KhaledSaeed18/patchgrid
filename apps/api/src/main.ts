import { existsSync } from "node:fs"
import path from "node:path"
import process from "node:process"

import { startTelemetry } from "./telemetry/otel"

/**
 * The entry point does three things, in an order that is load-bearing: read
 * the local `.env`, start telemetry, THEN load the application. The
 * OpenTelemetry instrumentations patch `http`, `pg`, `ioredis` and `pino` as
 * those modules are first required (ADR-0030, ADR-0046), so Nest and
 * everything under it must be required after the SDK is up — which is why
 * `bootstrap.ts` is loaded with `require` below rather than imported here.
 */
/**
 * The repository root `.env` is the local development source of variables. Node
 * 24 loads it natively, so no dotenv dependency. In every other environment the
 * variables are supplied directly and a missing file is not an error — the Zod
 * schema is what decides whether the configuration is complete.
 *
 * The file is found by walking *up* rather than by a fixed `../../..`: that
 * relative path only works because `src/` and `dist/` happen to sit at the same
 * depth, which is the kind of coincidence that breaks in a container and takes
 * an afternoon to diagnose. `ENV_FILE` overrides the search entirely.
 */
function loadLocalEnv(): void {
  const explicit = process.env.ENV_FILE
  const candidates: string[] = []

  if (explicit !== undefined && explicit !== "") {
    candidates.push(path.resolve(explicit))
  } else {
    // `__dirname`, not `import.meta.dirname`: this app compiles to CommonJS, and
    // `import.meta` is not available there.
    let directory = __dirname
    for (let depth = 0; depth < 6; depth += 1) {
      candidates.push(path.join(directory, ".env"))
      const parent = path.dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }

  const found = candidates.find((candidate) => existsSync(candidate))
  if (found === undefined) return

  try {
    process.loadEnvFile(found)
  } catch {
    // unreadable or malformed — the Zod schema reports what is missing
  }
}

loadLocalEnv()
startTelemetry()

// eslint-disable-next-line @typescript-eslint/no-require-imports -- after the SDK, on purpose (see above)
const { bootstrap } = require("./bootstrap") as typeof import("./bootstrap")
void bootstrap()
