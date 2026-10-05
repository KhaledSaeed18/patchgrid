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
}
