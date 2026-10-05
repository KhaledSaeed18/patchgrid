import { test } from "node:test"
import tsParser from "@typescript-eslint/parser"
import { RuleTester } from "eslint"

import { API_ZONES } from "./boundaries.js"
import { importZones } from "./rules/import-zones.js"

/**
 * Each zone is proven by the violation it names, and by the module that is
 * allowed to make it. A boundary that was never seen to fail is a comment.
 */
const tester = new RuleTester({
  languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: "module" },
})

const options = [{ zones: API_ZONES }]
const errorFor = (source) => [
  { message: new RegExp(`^'${source.replaceAll(".", "\\.")}' may not be imported here\\. .+\\(`) },
]

test("api import zones", () => {
  tester.run("import-zones", importZones, {
    valid: [
      // layering: repositories and the prisma module may import Prisma
      { code: 'import { Prisma } from "@patchgrid/database"', filename: "src/tickets/repositories/ticket.repository.ts", options },
      { code: 'import { createPrismaClient } from "@patchgrid/database"', filename: "src/prisma/prisma.service.ts", options },
      { code: 'import type { TenantTransactionClient } from "@patchgrid/database"', filename: "src/prisma/prisma.service.spec.ts", options },
      // crossing: the named modules
      { code: 'import { runAsTenant } from "../../platform/run-as-tenant"', filename: "src/jobs/sla/sla.processor.ts", options },
      { code: 'import { runAsTenant } from "../../platform/run-as-tenant"', filename: "src/orgs/provisioning/provisioning.service.ts", options },
      { code: 'import { runAsPlatform } from "../../platform/run-as-platform"', filename: "src/jobs/dispatcher/dispatcher.ts", options },
      { code: 'import { runAsPlatform } from "../platform/run-as-platform"', filename: "src/auth/api-token.strategy.ts", options },
      { code: 'import { runAsTenant } from "./run-as-tenant"', filename: "src/platform/support-session.service.ts", options },
      // context writers
      { code: 'import { ClsService } from "nestjs-cls"', filename: "src/tenancy/tenant-resolution.middleware.ts", options },
      { code: 'import { ClsServiceManager } from "nestjs-cls"', filename: "src/platform/crossing.ts", options },
      { code: 'import { ClsService } from "nestjs-cls"', filename: "src/auth/auth.guard.ts", options },
      // unrelated imports anywhere
      { code: 'import { z } from "zod"', filename: "src/tickets/tickets.service.ts", options },
      // tests are exempt from every zone
      { code: 'import { runAsPlatform } from "../platform/run-as-platform"', filename: "src/tickets/tickets.service.spec.ts", options },
      { code: 'import { PrismaClient } from "@prisma/client"', filename: "test/factories/org.ts", options },
    ],
    invalid: [
      // layering
      { code: 'import { PrismaClient } from "@prisma/client"', filename: "src/tickets/tickets.service.ts", options, errors: errorFor("@prisma/client") },
      { code: 'import { Prisma } from "@patchgrid/database"', filename: "src/tickets/tickets.controller.ts", options, errors: errorFor("@patchgrid/database") },
      { code: 'import { Role } from "@patchgrid/database/client"', filename: "src/authz/permission.service.ts", options, errors: errorFor("@patchgrid/database/client") },
      { code: 'import { Role } from "../../../packages/database/generated/client/enums"', filename: "src/authz/permission.service.ts", options, errors: errorFor("../../../packages/database/generated/client/enums") },
      // a type-only import is still a dependency on the storage layer
      { code: 'import type { Prisma } from "@patchgrid/database"', filename: "src/tickets/tickets.service.ts", options, errors: errorFor("@patchgrid/database") },
      // dynamic import and require do not slip past
      { code: 'const db = await import("@patchgrid/database")', filename: "src/tickets/tickets.service.ts", options, errors: errorFor("@patchgrid/database") },
      { code: 'const db = require("@patchgrid/database")', filename: "src/tickets/tickets.service.ts", options, errors: errorFor("@patchgrid/database") },
      // crossing: a per-tenant job may not run with no tenant
      { code: 'import { runAsPlatform } from "../../platform/run-as-platform"', filename: "src/jobs/sla/sla.processor.ts", options, errors: errorFor("../../platform/run-as-platform") },
      { code: 'import { runAsTenant } from "../platform/run-as-tenant"', filename: "src/tickets/tickets.service.ts", options, errors: errorFor("../platform/run-as-tenant") },
      { code: 'import { runAsTenant } from "../../platform/run-as-tenant"', filename: "src/orgs/settings/settings.service.ts", options, errors: errorFor("../../platform/run-as-tenant") },
      // context writers
      { code: 'import { ClsService } from "nestjs-cls"', filename: "src/tickets/tickets.service.ts", options, errors: errorFor("nestjs-cls") },
      { code: 'import { ClsService } from "nestjs-cls"', filename: "src/orgs/orgs.service.ts", options, errors: errorFor("nestjs-cls") },
    ],
  })
})
