import { Controller, Get, HttpCode, Param, Post } from "@nestjs/common"
import { type DeadLetter, type DeadLetterList, idSchema } from "@patchgrid/contracts"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"

import { RequirePermission } from "../../authz/require-permission"
import { DeadLettersService } from "./dead-letters.service"

class DeadLetterParamsDto extends createZodDto(z.object({ id: idSchema })) {}

/** `/org/events/dead-letters` — what the log's consumers gave up on (ADR-0049). */
@Controller("org/events/dead-letters")
export class DeadLettersController {
  constructor(private readonly letters: DeadLettersService) {}

  @Get()
  @RequirePermission("org:manage_events")
  list(): Promise<DeadLetterList> {
    return this.letters.list()
  }

  @Post(":id/replay")
  @HttpCode(200)
  @RequirePermission("org:manage_events")
  replay(@Param() params: DeadLetterParamsDto): Promise<DeadLetter> {
    return this.letters.replay(params.id)
  }
}
