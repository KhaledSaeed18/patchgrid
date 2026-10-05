import { Global, Module } from "@nestjs/common"
import { randomUUID } from "node:crypto"
import type { IncomingMessage } from "node:http"
import { ClsModule } from "nestjs-cls"

import { TenantContextService } from "./tenant-context.service"

/**
 * Opens the request context (ARCHITECTURE.md §Request pipeline, step 5).
 *
 * The CLS middleware wraps every route, so by the time a handler runs there is
 * a store for the tenant resolution middleware to write into and for
 * `PrismaService` to read from. It establishes NO tenant itself: a request
 * that reaches a repository without passing tenant resolution finds an empty
 * store, and the client extension throws rather than running unscoped.
 */
@Global()
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        // pino-http has already stamped `req.id`, so the CLS id and the log
        // lines agree. The fallback exists for a route the logger skips.
        idGenerator: (req: IncomingMessage & { id?: unknown }) =>
          typeof req.id === "string" && req.id !== "" ? req.id : randomUUID(),
      },
    }),
  ],
  providers: [TenantContextService],
  exports: [TenantContextService],
})
export class TenancyModule {}
