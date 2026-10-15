import { Global, Module } from "@nestjs/common"

import { CLOCK, SystemClock } from "./clock/clock"
import { OtelTracer } from "../telemetry/otel-tracer"
import { TRACER } from "./tracing/tracer"
import { PublicUrls } from "./urls"

/**
 * The two seams every module injects: time (`Clock`, so SLA maths and token
 * expiry are pure functions of an input) and tracing (`Tracer`, ADR-0030). Global, because a module that cannot see the clock reaches
 * for `new Date()`, and that is how tests end up sleeping.
 */
@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    // Backed by OpenTelemetry (ADR-0030); non-recording until `main.ts` starts the SDK.
    { provide: TRACER, useClass: OtelTracer },
    PublicUrls,
  ],
  exports: [CLOCK, TRACER, PublicUrls],
})
export class CommonModule {}
