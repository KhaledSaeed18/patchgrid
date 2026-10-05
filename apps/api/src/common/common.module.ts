import { Global, Module } from "@nestjs/common"

import { CLOCK, SystemClock } from "./clock/clock"
import { NoopTracer, TRACER } from "./tracing/tracer"
import { PublicUrls } from "./urls"

/**
 * The two seams every module injects: time (`Clock`, so SLA maths and token
 * expiry are pure functions of an input) and tracing (`Tracer`, a no-op until
 * ADR-0030 lands). Global, because a module that cannot see the clock reaches
 * for `new Date()`, and that is how tests end up sleeping.
 */
@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: TRACER, useClass: NoopTracer },
    PublicUrls,
  ],
  exports: [CLOCK, TRACER, PublicUrls],
})
export class CommonModule {}
