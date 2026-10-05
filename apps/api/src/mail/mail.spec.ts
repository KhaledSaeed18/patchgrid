import { Logger } from "@nestjs/common"
import { ClsServiceManager } from "nestjs-cls"
import { type Job, UnrecoverableError } from "bullmq"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { AppConfig } from "../config/app-config"
import type { RequestContextStore } from "../tenancy/request-context"
import { TenantContextService } from "../tenancy/tenant-context.service"
import { MailProcessor } from "./mail.processor"
import { MailService } from "./mail.service"
import { RecordingMailProvider } from "./providers/recording-mail.provider"
import type { MailJob } from "./templates"

const ORG = "0190b2f0-0000-7000-8000-00000000000a"
const config = { MAIL_FROM: "Patchgrid <notifications@patchgrid.test>", WORKER_MODE: "all" } as AppConfig
const invite: MailJob = {
  kind: "invite",
  to: "agent@acme.test",
  orgId: ORG,
  fromName: "Acme",
  params: { orgName: "Acme", inviterName: "Ada", role: "AGENT", acceptUrl: "https://app.lvh.me:3001/invite?token=x", expiresInDays: 7 },
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined)
})

describe("MailService.enqueue", () => {
  it("adds a validated payload under an idempotent per-tenant job id", async () => {
    const queue = { add: vi.fn(async () => undefined) }
    await new MailService(queue as never).enqueue(invite, "inv-1")
    expect(queue.add).toHaveBeenCalledWith("invite", invite, { jobId: `mail:${ORG}:inv-1:invite` })
  })

  it("refuses a payload the templates cannot render before it reaches the queue", async () => {
    const queue = { add: vi.fn() }
    await expect(
      new MailService(queue as never).enqueue({ ...invite, params: { ...invite.params, acceptUrl: "not a url" } }, "inv-1"),
    ).rejects.toThrow()
    expect(queue.add).not.toHaveBeenCalled()
  })
})

describe("MailProcessor.process", () => {
  const context = new TenantContextService(ClsServiceManager.getClsService<RequestContextStore>())

  it("renders inside the job's tenant and sends from the tenant's name at our address", async () => {
    const provider = new RecordingMailProvider()
    const seen: (string | undefined)[] = []
    const spy = vi.spyOn(provider, "send").mockImplementation(async (mail) => {
      seen.push(context.current()?.orgId)
      provider.sent.push(mail)
      return { providerMessageId: "m-1" }
    })
    await new MailProcessor(provider, config).process({ id: "j1", data: invite } as Job)
    expect(seen).toEqual([ORG])
    expect(provider.sent[0]).toMatchObject({
      to: "agent@acme.test",
      from: { name: "Acme", address: "notifications@patchgrid.test" },
      subject: "You're invited to Acme on Patchgrid",
    })
    expect(provider.sent[0]?.html).toContain("https://app.lvh.me:3001/invite?token=x")
    spy.mockRestore()
  })

  it("runs platform mail with no tenant context", async () => {
    const provider = new RecordingMailProvider()
    let orgInContext: string | undefined = "unset"
    vi.spyOn(provider, "send").mockImplementation(async () => {
      orgInContext = context.current()?.orgId
      return { providerMessageId: "m-2" }
    })
    const verify: MailJob = { kind: "verify-email", to: "new@acme.test", orgId: null, fromName: "Patchgrid", params: { name: "Sam", verifyUrl: "https://app.lvh.me:3001/verify?token=x", expiresInHours: 24 } }
    await new MailProcessor(provider, config).process({ id: "j2", data: verify } as Job)
    expect(orgInContext).toBeUndefined()
  })

  it("marks an unreadable payload unrecoverable instead of retrying it", async () => {
    const provider = new RecordingMailProvider()
    await expect(
      new MailProcessor(provider, config).process({ id: "j3", data: { kind: "newsletter" } } as Job),
    ).rejects.toBeInstanceOf(UnrecoverableError)
    expect(provider.sent).toHaveLength(0)
  })

  it("lets the provider's failure propagate so BullMQ retries with backoff", async () => {
    const provider = new RecordingMailProvider()
    vi.spyOn(provider, "send").mockRejectedValue(new Error("ECONNREFUSED"))
    await expect(new MailProcessor(provider, config).process({ id: "j4", data: invite } as Job)).rejects.toThrow("ECONNREFUSED")
  })
})
