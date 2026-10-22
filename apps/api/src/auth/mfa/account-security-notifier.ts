import { Injectable, Logger } from "@nestjs/common"

import { type Clock, InjectClock } from "../../common/clock/clock"
import { MailService } from "../../mail/mail.service"
import type { AccountSecurityEvent } from "../../mail/templates/account-security"
import { UserRepository } from "../../platform/repositories/user.repository"

/**
 * Tells a person, by mail, that one of their factors changed or came under
 * attack (ADR-0029, ADR-0045, ADR-0053). After the fact and best effort: the
 * change stands whether or not the mail goes.
 */
@Injectable()
export class AccountSecurityNotifier {
  private readonly logger = new Logger(AccountSecurityNotifier.name)

  constructor(
    private readonly users: UserRepository,
    private readonly mail: MailService,
    @InjectClock() private readonly clock: Clock,
  ) {}

  async tell(userId: string, event: AccountSecurityEvent, remaining: number): Promise<void> {
    try {
      const account = await this.users.findById(userId)
      if (account === null) return
      await this.mail.enqueue(
        { kind: "account-security", to: account.email, orgId: null, fromName: "Patchgrid", params: { event, remaining } },
        `${userId}.${event}.${String(this.clock.now().getTime())}`,
      )
    } catch (error) {
      this.logger.error({ msg: "account security mail not queued", userId, event, error: String(error) })
    }
  }
}
