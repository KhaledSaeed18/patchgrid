import { Processor, WorkerHost } from "@nestjs/bullmq"
import { Inject, Logger, type OnApplicationBootstrap } from "@nestjs/common"
import { type Job, UnrecoverableError } from "bullmq"

import { emailHash8 } from "../common/privacy"
import { InjectConfig, type AppConfig } from "../config/app-config"
import { runJob } from "../jobs/dispatcher/run-job"
import { MAIL_PROVIDER, type MailProvider } from "./mail-provider"
import { MAIL_QUEUE } from "./mail.service"
import { mailJobSchema, renderMail } from "./templates"

/**
 * Renders and sends. Runs inside the tenant the job names (ADR-0018), so a
 * template may one day include tenant data safely; platform mail — verify,
 * reset — runs with no tenant at all.
 *
 * `autorun: false` plus `WORKER_MODE`: the processor exists in every mode and
 * consumes only when this process is meant to do work.
 */
@Processor(MAIL_QUEUE, { autorun: false, concurrency: 5 })
export class MailProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(MailProcessor.name)
  private readonly fromAddress: string

  constructor(
    @Inject(MAIL_PROVIDER) private readonly provider: MailProvider,
    @InjectConfig() private readonly config: AppConfig,
  ) {
    super()
    // Validated to this shape by the env schema.
    this.fromAddress = /<([^<>]+)>$/.exec(config.MAIL_FROM)?.[1] ?? config.MAIL_FROM
  }

  onApplicationBootstrap(): void {
    if (this.config.WORKER_MODE === "api") {
      this.logger.log("mail worker idle: WORKER_MODE=api")
      return
    }
    void this.worker.run()
  }

  async process(job: Job): Promise<void> {
    const parsed = mailJobSchema.safeParse(job.data)
    if (!parsed.success) {
      // Retrying a payload this code cannot read changes nothing.
      throw new UnrecoverableError(`mail job ${String(job.id)} has an unreadable payload: ${parsed.error.message}`)
    }
    const data = parsed.data

    await runJob(data, "job:mail", data.kind, async () => {
      const rendered = await renderMail(data)
      const { providerMessageId } = await this.provider.send({
        to: data.to,
        from: { name: data.fromName, address: this.fromAddress },
        ...rendered,
      })
      this.logger.log({
        msg: "mail sent",
        kind: data.kind,
        jobId: job.id,
        to: emailHash8(data.to),
        providerMessageId,
      })
    })
  }
}
