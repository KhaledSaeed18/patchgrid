/**
 * An operator signed in at the admin surface, through the real flow (ADR-0040):
 * password, enrolment, confirmation. The browser keeps its cookies the way a
 * real one would, so `pg_pa` travels only to `/api/v1/platform`.
 */
import type { INestApplication } from "@nestjs/common"
import type { PrismaClient } from "@patchgrid/database"
import { randomUUID } from "node:crypto"
import request from "supertest"

import { codeAt } from "../../src/auth/mfa/totp"
import { PasswordService } from "../../src/auth/passwords/password.service"
import { HEADERS } from "./workspace"

export const ADMIN_ORIGIN = "http://admin.lvh.me:3001"

export type Operator = {
  userId: string
  platformAdminId: string
  email: string
  get: (path: string) => Promise<request.Response>
  post: (path: string, body?: object) => Promise<request.Response>
  put: (path: string, body?: object) => Promise<request.Response>
  cleanup: () => Promise<void>
}

export async function signInOperator(app: INestApplication, db: PrismaClient): Promise<Operator> {
  const email = `operator-${randomUUID().slice(0, 8)}@patchgrid.test`
  const password = "operator-password-123"
  const passwordHash = await app.get(PasswordService).hash(password)
  const user = await db.user.create({ data: { email, name: "Olga Operator", passwordHash, emailVerifiedAt: new Date() } })
  const admin = await db.platformAdmin.create({ data: { userId: user.id } })

  const jar = new Map<string, string>()
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ")
  const keep = (response: request.Response) => {
    for (const line of (response.headers["set-cookie"] as unknown as string[] | undefined) ?? []) {
      const [name, value] = (line.split(";")[0] ?? "").split("=")
      if (name !== undefined) {
        if (value === undefined || value === "") jar.delete(name)
        else jar.set(name, value)
      }
    }
    return response
  }
  const http = () => request(app.getHttpServer())
  const send = (method: "post" | "put") => async (path: string, body: object = {}) =>
    keep(await http()[method](`/api/v1/platform${path}`).set(HEADERS).set("Origin", ADMIN_ORIGIN).set("Cookie", cookie()).send(body))
  const post = send("post")

  await post("/auth/login", { email, password })
  const enrol = await post("/auth/mfa/enrol")
  await post("/auth/mfa/confirm", { code: codeAt(enrol.body.secret as string, new Date()) })

  return {
    userId: user.id,
    platformAdminId: admin.id,
    email,
    get: async (path) => keep(await http().get(`/api/v1/platform${path}`).set("Origin", ADMIN_ORIGIN).set("Cookie", cookie())),
    post,
    put: send("put"),
    cleanup: async () => {
      await db.auditLog.deleteMany({ where: { actorPlatformAdminId: admin.id } })
      await db.platformAuditLog.deleteMany({ where: { platformAdminId: admin.id } })
      await db.platformAdmin.delete({ where: { id: admin.id } })
      await db.user.delete({ where: { id: user.id } })
    },
  }
}
