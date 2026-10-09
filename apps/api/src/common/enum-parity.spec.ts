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
  auditActorKindSchema,
  usageMetricSchema,
  ticketTypeSchema,
  ticketStatusSchema,
  impactSchema,
  urgencySchema,
  prioritySchema,
  ticketSourceSchema,
  commentVisibilitySchema,
  commentAuthorKindSchema,
  membershipKindSchema,
  membershipStatusSchema,
  organizationStatusSchema,
  planSchema,
  roleSchema,
} from "@patchgrid/contracts"
import {
  AgentVisibility,
  AuditActorKind,
  UsageMetric,
  TicketType,
  TicketStatus,
  Impact,
  Urgency,
  Priority,
  TicketSource,
  CommentVisibility,
  CommentAuthorKind,
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
expectTypeOf<z.infer<typeof auditActorKindSchema>>().toEqualTypeOf<Values<typeof AuditActorKind>>()
expectTypeOf<z.infer<typeof usageMetricSchema>>().toEqualTypeOf<Values<typeof UsageMetric>>()
expectTypeOf<z.infer<typeof ticketTypeSchema>>().toEqualTypeOf<Values<typeof TicketType>>()
expectTypeOf<z.infer<typeof ticketStatusSchema>>().toEqualTypeOf<Values<typeof TicketStatus>>()
expectTypeOf<z.infer<typeof impactSchema>>().toEqualTypeOf<Values<typeof Impact>>()
expectTypeOf<z.infer<typeof urgencySchema>>().toEqualTypeOf<Values<typeof Urgency>>()
expectTypeOf<z.infer<typeof prioritySchema>>().toEqualTypeOf<Values<typeof Priority>>()
expectTypeOf<z.infer<typeof ticketSourceSchema>>().toEqualTypeOf<Values<typeof TicketSource>>()
expectTypeOf<z.infer<typeof commentVisibilitySchema>>().toEqualTypeOf<Values<typeof CommentVisibility>>()
expectTypeOf<z.infer<typeof commentAuthorKindSchema>>().toEqualTypeOf<Values<typeof CommentAuthorKind>>()

describe("wire and storage enums", () => {
  it.each([
    ["Role", roleSchema.options, Role],
    ["MembershipStatus", membershipStatusSchema.options, MembershipStatus],
    ["MembershipKind", membershipKindSchema.options, MembershipKind],
    ["OrganizationStatus", organizationStatusSchema.options, OrganizationStatus],
    ["Plan", planSchema.options, Plan],
    ["AgentVisibility", agentVisibilitySchema.options, AgentVisibility],
    ["AuditActorKind", auditActorKindSchema.options, AuditActorKind],
    ["UsageMetric", usageMetricSchema.options, UsageMetric],
    ["TicketType", ticketTypeSchema.options, TicketType],
    ["TicketStatus", ticketStatusSchema.options, TicketStatus],
    ["Impact", impactSchema.options, Impact],
    ["Urgency", urgencySchema.options, Urgency],
    ["Priority", prioritySchema.options, Priority],
    ["TicketSource", ticketSourceSchema.options, TicketSource],
    ["CommentVisibility", commentVisibilitySchema.options, CommentVisibility],
    ["CommentAuthorKind", commentAuthorKindSchema.options, CommentAuthorKind],
  ] as const)("%s has the same values on both sides", (_name, wire, storage) => {
    expect([...wire]).toEqual(Object.values(storage))
  })
})
