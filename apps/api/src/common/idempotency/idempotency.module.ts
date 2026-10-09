import { Module } from "@nestjs/common"
import { APP_INTERCEPTOR } from "@nestjs/core"

import { AuthModule } from "../../auth/auth.module"
import { IdempotencyInterceptor } from "./idempotency"

/** Registers the interceptor app-wide; it acts only on routes marked `@Idempotent()`. */
@Module({
  imports: [AuthModule],
  providers: [{ provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor }],
})
export class IdempotencyModule {}
