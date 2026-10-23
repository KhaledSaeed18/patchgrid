import { Module } from "@nestjs/common"

import { AuthModule } from "../../auth/auth.module"
import { DeadLetterRepository } from "../repositories/dead-letter.repository"
import { OutboxRepository } from "../repositories/outbox.repository"
import { DeadLettersController } from "./dead-letters.controller"
import { DeadLettersService } from "./dead-letters.service"

/** The dead-letter view and replay; apart from the global events module, which the auth module needs. */
@Module({
  imports: [AuthModule],
  controllers: [DeadLettersController],
  providers: [DeadLetterRepository, OutboxRepository, DeadLettersService],
})
export class DeadLettersModule {}
