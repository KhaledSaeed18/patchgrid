/**
 * Every enum that crosses the wire exists twice: as a Zod enum in
 * @patchgrid/contracts (the wire) and as a Prisma enum (storage). They are
 * declared apart on purpose — the contract must not depend on the schema — so
 * this is what stops them drifting (ENGINEERING.md §Testing).
 *
 * The type assertions fail `pnpm typecheck`, before any test runs. The runtime
 * assertions repeat them for the value sets, whose order the types cannot see.
 */
import {
  agentVisibilitySchema,
  membershipKindSchema,
  membershipStatusSchema,
  organizationStatusSchema,
  planSchema,
  roleSchema,
} from "@patchgrid/contracts"
import {
  AgentVisibility,
  MembershipKind,
  MembershipStatus,
  OrganizationStatus,
  Plan,
  Role,
} from "@patchgrid/database"
import type { z } from "zod"
import { describe, expect, expectTypeOf, it } from "vitest"

type Values<T> = T[keyof T]

expectTypeOf<z.infer<typeof roleSchema>>().toEqualTypeOf<Values<typeof Role>>()
expectTypeOf<z.infer<typeof membershipStatusSchema>>().toEqualTypeOf<Values<typeof MembershipStatus>>()
expectTypeOf<z.infer<typeof membershipKindSchema>>().toEqualTypeOf<Values<typeof MembershipKind>>()
expectTypeOf<z.infer<typeof organizationStatusSchema>>().toEqualTypeOf<Values<typeof OrganizationStatus>>()
expectTypeOf<z.infer<typeof planSchema>>().toEqualTypeOf<Values<typeof Plan>>()
expectTypeOf<z.infer<typeof agentVisibilitySchema>>().toEqualTypeOf<Values<typeof AgentVisibility>>()

describe("wire and storage enums", () => {
  it.each([
    ["Role", roleSchema.options, Role],
    ["MembershipStatus", membershipStatusSchema.options, MembershipStatus],
    ["MembershipKind", membershipKindSchema.options, MembershipKind],
    ["OrganizationStatus", organizationStatusSchema.options, OrganizationStatus],
    ["Plan", planSchema.options, Plan],
    ["AgentVisibility", agentVisibilitySchema.options, AgentVisibility],
  ] as const)("%s has the same values on both sides", (_name, wire, storage) => {
    expect([...wire]).toEqual(Object.values(storage))
  })
})
