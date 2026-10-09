/**
 * Seeds a workspace straight through the owner role — an organization, its
 * people with their roles, the picker rows and any teams — and signs each
 * person in through the real login route, so a spec starts from "these people
 * are in this workspace" without replaying the invitation flow every time.
 */
import type { INestApplication } from "@nestjs/common"
import type { PrismaClient, Role } from "@patchgrid/database"
import { randomUUID } from "node:crypto"
import request from "supertest"

import { PasswordService } from "../../src/auth/passwords/password.service"

export const HEADERS = { "Content-Type": "application/json", "X-Requested-With": "patchgrid" }
const PASSWORD = "correct horse battery staple"

export type Person = { userId: string; membershipId: string; email: string; access: string; pgId: string }

export type Workspace<P extends string> = {
  orgId: string
  slug: string
  origin: string
  people: Record<P, Person>
  teams: Record<string, string>
  /** Removes everything the seed and the spec wrote for this workspace. */
  cleanup: () => Promise<void>
}

export async function seedWorkspace<P extends string>(
  app: INestApplication,
  db: PrismaClient,
  options: { people: Record<P, Role>; teams?: string[]; prefix?: string },
): Promise<Workspace<P>> {
  const suffix = randomUUID().slice(0, 8)
  const slug = `${options.prefix ?? "ws"}-${suffix}`
  const org = await db.organization.create({ data: { name: `Workspace ${suffix}`, slug } })
  const passwordHash = await app.get(PasswordService).hash(PASSWORD)

  const teams: Record<string, string> = {}
  for (const name of options.teams ?? []) {
    teams[name] = (await db.team.create({ data: { orgId: org.id, name } })).id
  }

  const people = {} as Record<P, Person>
  for (const [key, role] of Object.entries(options.people) as [P, Role][]) {
    const email = `${key}-${suffix}@probe.test`
    const user = await db.user.create({ data: { email, name: key, passwordHash, emailVerifiedAt: new Date() } })
    const membership = await db.membership.create({
      data: { orgId: org.id, userId: user.id, role, displayName: key, joinedAt: new Date() },
    })
    await db.userOrgIndex.create({
      data: { userId: user.id, orgId: org.id, roleForDisplay: role, statusForDisplay: "ACTIVE", orgSlug: slug, orgName: org.name, orgStatus: "ACTIVE" },
    })
    const login = await request(app.getHttpServer()).post("/api/v1/auth/login").set(HEADERS).send({ email, password: PASSWORD, slug })
    const cookies = ((login.headers["set-cookie"] as unknown as string[] | undefined) ?? []).map((c) => c.split(";")[0] ?? "")
    people[key] = {
      userId: user.id,
      membershipId: membership.id,
      email,
      access: cookies.find((c) => c.startsWith(`pg_at_${slug}=`)) ?? "",
      pgId: cookies.find((c) => c.startsWith("pg_id=")) ?? "",
    }
  }

  // The seat counter as provisioning would have left it (TENANCY.md §8).
  const seats = Object.values<Role>(options.people).filter((role) => role !== "REQUESTER").length
  await db.usageCounter.create({ data: { orgId: org.id, period: "current", metric: "AGENT_SEATS", value: BigInt(seats) } })

  const cleanup = async () => {
    const userIds = Object.values<Person>(people).map((p) => p.userId)
    await db.auditLog.deleteMany({ where: { orgId: org.id } })
    await db.invitation.deleteMany({ where: { orgId: org.id } })
    await db.teamMembership.deleteMany({ where: { orgId: org.id } })
    await db.membership.updateMany({ where: { orgId: org.id }, data: { invitedByMembershipId: null } })
    await db.membership.deleteMany({ where: { orgId: org.id } })
    await db.team.deleteMany({ where: { orgId: org.id } })
    await db.userOrgIndex.deleteMany({ where: { orgId: org.id } })
    await db.usageCounter.deleteMany({ where: { orgId: org.id } })
    await db.refreshToken.deleteMany({ where: { userId: { in: userIds } } })
    await db.organization.delete({ where: { id: org.id } })
    await db.user.deleteMany({ where: { id: { in: userIds } } })
  }

  return { orgId: org.id, slug, origin: `http://${slug}.lvh.me:3001`, people, teams, cleanup }
}

/** A browser on the workspace: its access cookie, its Origin, the CSRF header on writes. */
export function browser(app: INestApplication, origin: string, access: string) {
  const http = () => request(app.getHttpServer())
  return {
    get: (path: string) => http().get(`/api/v1${path}`).set("Origin", origin).set("Cookie", access),
    post: (path: string, body: object = {}) =>
      http().post(`/api/v1${path}`).set(HEADERS).set("Origin", origin).set("Cookie", access).send(body),
    put: (path: string, body: object = {}) =>
      http().put(`/api/v1${path}`).set(HEADERS).set("Origin", origin).set("Cookie", access).send(body),
    patch: (path: string, body: object) =>
      http().patch(`/api/v1${path}`).set(HEADERS).set("Origin", origin).set("Cookie", access).send(body),
    delete: (path: string) => http().delete(`/api/v1${path}`).set(HEADERS).set("Origin", origin).set("Cookie", access),
  }
}
