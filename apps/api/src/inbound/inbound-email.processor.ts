import { Processor, WorkerHost } from "@nestjs/bullmq"
import { Injectable, type OnApplicationBootstrap } from "@nestjs/common"
import { idSchema } from "@patchgrid/contracts"
import { type Job, UnrecoverableError } from "bullmq"
import { z } from "zod"

import { InjectConfig, type AppConfig } from "../config/app-config"
import { runJob } from "../jobs/dispatcher/run-job"
import { InboundIntakeService } from "./inbound-intake.service"
import { INBOUND_QUEUE } from "./inbound-receiver.service"

const payloadSchema = z.object({ orgId: idSchema, rawStorageKey: z.string().startsWith("org/"), receivedAt: z.iso.datetime() })

/**
 * One inbound message, in its tenant (ADR-0018): the intake runs in the
 * context a request to that workspace would have. A message still unsettled
 * when its last attempt fails is marked `FAILED`, and the hourly inbound
 * sweep fails whatever a dead worker left claimed — the log never shows one
 * waiting forever.
 */
@Injectable()
@Processor(INBOUND_QUEUE, { autorun: false, concurrency: 5 })
export class InboundEmailProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly intake: InboundIntakeService,
    @InjectConfig() private readonly config: AppConfig,
  ) {
    super()
  }

  onApplicationBootstrap(): void {
    if (this.config.WORKER_MODE !== "api") void this.worker.run()
  }

  async process(job: Job): Promise<string> {
    const parsed = payloadSchema.safeParse(job.data)
    if (!parsed.success) throw new UnrecoverableError(`inbound job ${String(job.id)} has an unreadable payload`)
    const payload = parsed.data
    // Keys are written under the org they belong to; one that is not is a bug, not mail.
    if (!payload.rawStorageKey.startsWith(`org/${payload.orgId}/`))
      throw new UnrecoverableError(`inbound job ${String(job.id)} names another org's key`)
    // The intake settles or releases the message itself; a final attempt fails it rather than leaving it waiting.
    const last = job.attemptsMade + 1 >= (job.opts.attempts ?? 1)
    return runJob(payload, "job:inbound-email", "process", () => this.intake.process(payload, { last }))
  }
}
