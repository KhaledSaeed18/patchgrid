import { Global, Module } from "@nestjs/common"

import { ActorService } from "../auth/actor"
import { TelemetryMiddleware } from "./telemetry.middleware"

/**
 * The request middleware (ADR-0030, ADR-0046). The SDK itself starts in
 * `main.ts`, before any module loads, and the `Tracer` seam is provided by
 * `CommonModule`. Deliberately imports no feature module: importing
 * `AuthModule` here would register its global guards ahead of the tenancy
 * module's resolution guard, and authentication would run before the tenant
 * exists. `ActorService` is a stateless reader over the request store, so a
 * second instance of it costs nothing.
 */
@Global()
@Module({
  providers: [TelemetryMiddleware, ActorService],
  exports: [TelemetryMiddleware],
})
export class TelemetryModule {}
