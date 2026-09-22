import type { ProblemError } from "@patchgrid/contracts"
import { createZodValidationPipe } from "nestjs-zod"
import { ZodError } from "zod"

import { ProblemException, ValidationProblem } from "./problem.exception"

/**
 * Turns a schema failure straight into a `ValidationProblem`, so the global
 * filter has nothing to reverse-engineer and there is one shape of validation
 * error in the system.
 *
 * `strictSchemaDeclaration` makes the pipe throw when it is handed a value that
 * is not described by a contract schema — the failure mode being "we thought
 * this was validated and it never was", which is silent by nature.
 */
export const ZodValidationPipe = createZodValidationPipe({
  strictSchemaDeclaration: true,
  // The library types this argument as `unknown`, so narrow rather than assert.
  // Anything that is not a ZodError reaching here is a bug in the pipe, not a
  // client error — surface it as one instead of mislabelling it a 400.
  createValidationException: (error: unknown) => {
    if (!(error instanceof ZodError)) {
      return new ProblemException("internal-error", undefined)
    }
    return new ValidationProblem(
      error.issues.map(
        (issue): ProblemError => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
          code: issue.code,
        }),
      ),
    )
  },
})
