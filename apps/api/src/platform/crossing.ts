import { Logger } from "@nestjs/common"
import { ClsServiceManager } from "nestjs-cls"

import type { RequestContextStore } from "../tenancy/request-context"

/**
 * Who is crossing a tenant boundary, and why. Both are logged on every call
 * (ARCHITECTURE.md §Security posture): a crossing nobody can explain is a
 * crossing nobody should have made.
 */
export type Crossing = {
  /** `job:sla-scan`, `platform-admin:<id>`, `auth:api-token`, … — ids only, never PII. */
  actor: string
  reason: string
}

export const crossingLogger = new Logger("TenantCrossing")

/** The one CLS instance, shared with the module Nest injects. */
export function requestContext() {
  return ClsServiceManager.getClsService<RequestContextStore>()
}
