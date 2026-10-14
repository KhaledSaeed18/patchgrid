import { InjectQueue } from "@nestjs/bullmq"
import { Injectable, Logger } from "@nestjs/common"
import type { Queue } from "bullmq"

import { emailHash8 } from "../common/privacy"
import { jobId } from "../jobs/job-id"
import { type MailJob, mailJobSchema } from "./templates"

export const MAIL_QUEUE = "mail"

/**
 * Enqueues; never sends. Anonymous identity endpoints must answer in the same
 * time whether or not an address exists (ADR-0031), and an SMTP round trip
 * inline would make the difference audible. The processor sends, with retries.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name)

  constructor(@InjectQueue(MAIL_QUEUE) private readonly queue: Queue) {}

  /**
   * `entityId` makes the job idempotent per tenant: re-enqueueing the same
   * invitation's mail is a no-op rather than a second message.
   */
  async enqueue(job: MailJob, entityId: string): Promise<void> {
    const data = mailJobSchema.parse(job)
    const id = jobId(MAIL_QUEUE, data.orgId, entityId, data.kind)
    await this.queue.add(data.kind, data, { jobId: id })
    this.logger.log({ msg: "mail enqueued", kind: data.kind, jobId: id, to: emailHash8(data.to) })
  }

  /** Many at once, in one round trip; each idempotent on its own `entityId` as `enqueue` is. */
  async enqueueAll(mails: readonly { job: MailJob; entityId: string }[]): Promise<void> {
    if (mails.length === 0) return
    // One unreadable message is logged and left out, not allowed to sink the rest.
    const jobs = mails.flatMap(({ job, entityId }) => {
      const parsed = mailJobSchema.safeParse(job)
      if (!parsed.success) {
        this.logger.error({ msg: "mail not enqueued: invalid", kind: job.kind, entityId, error: parsed.error.message })
        return []
      }
      const data = parsed.data
      return [{ name: data.kind, data, opts: { jobId: jobId(MAIL_QUEUE, data.orgId, entityId, data.kind) } }]
    })
    if (jobs.length === 0) return
    await this.queue.addBulk(jobs)
    this.logger.log({ msg: "mail enqueued", count: jobs.length, kinds: [...new Set(jobs.map((j) => j.name))] })
  }
}
