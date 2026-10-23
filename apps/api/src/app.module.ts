import { type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common"
import { APP_FILTER, APP_PIPE } from "@nestjs/core"
import { LoggerModule } from "nestjs-pino"
import { randomUUID } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"

import { CommonModule } from "./common/common.module"
import { IdempotencyModule } from "./common/idempotency/idempotency.module"
import { ProblemDetailsFilter } from "./common/problems/problem-details.filter"
import { ZodValidationPipe } from "./common/problems/zod-validation.pipe"
import { AuditModule } from "./audit/audit.module"
import { AuthModule } from "./auth/auth.module"
import { AuthzModule } from "./authz/authz.module"
import { CategoriesModule } from "./categories/categories.module"
import { APP_CONFIG, type AppConfig } from "./config/app-config"
import { ConfigModule } from "./config/config.module"
import { HealthModule } from "./health/health.module"
import { AssetsModule } from "./assets/assets.module"
import { AttachmentsModule } from "./attachments/attachments.module"
import { DispatchModule } from "./jobs/dispatcher/dispatch.module"
import { StorageModule } from "./storage/storage.module"
import { MaintenanceModule } from "./jobs/maintenance/maintenance.module"
import { PurgeModule } from "./jobs/purge/purge.module"
import { ExportsModule } from "./exports/exports.module"
import { InboundModule } from "./inbound/inbound.module"
import { BackofficeModule } from "./platform/backoffice/backoffice.module"
import { SupportModule } from "./support/support.module"
import { ApiTokensModule } from "./api-tokens/api-tokens.module"
import { JobsModule } from "./jobs/jobs.module"
import { KnowledgeModule } from "./knowledge/knowledge.module"
import { NotificationsModule } from "./notifications/notifications.module"
import { EventsModule } from "./events/events.module"
import { WebhooksModule } from "./webhooks/webhooks.module"
import { DeadLettersModule } from "./events/dead-letters/dead-letters.module"
import { ReportingModule } from "./reporting/reporting.module"
import { ViewsModule } from "./views/views.module"
import { SsoModule } from "./sso/sso.module"
import { MailModule } from "./mail/mail.module"
import { MembershipsModule } from "./memberships/memberships.module"
import { OrgsModule } from "./orgs/orgs.module"
import { PrismaModule } from "./prisma/prisma.module"
import { QuotaModule } from "./quota/quota.module"
import { RedisModule } from "./redis/redis.module"
import { SlaModule } from "./sla/sla.module"
import { TeamsModule } from "./teams/teams.module"
import { TicketsModule } from "./tickets/tickets.module"
import { TenantContextService } from "./tenancy/tenant-context.service"
import { TelemetryModule } from "./telemetry/telemetry.module"
import { TelemetryMiddleware } from "./telemetry/telemetry.middleware"
import { activeTraceId } from "./telemetry/metrics"
import { TenancyModule } from "./tenancy/tenancy.module"
import { ThrottlingModule } from "./throttling/throttling.module"

/** What a proxy's request id looks like; anything else is replaced, never echoed. */
const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/

@Module({
  imports: [
    ConfigModule,
    CommonModule,
    TelemetryModule,
    LoggerModule.forRootAsync({
      imports: [TenancyModule],
      inject: [APP_CONFIG, TenantContextService],
      useFactory: (config: AppConfig, tenantContext: TenantContextService) => ({
        pinoHttp: {
          level: config.LOG_LEVEL,
          // Pretty locally, JSON everywhere else — a log you cannot read during
          // development is a log nobody looks at.
          ...(config.isProduction
            ? {}
            : { transport: { target: "pino-pretty", options: { singleLine: true } } }),

          /**
           * One id per request, threaded through every log line and returned as
           * `correlationId` on 5xx responses (ADR-0012). An id supplied by an
           * upstream proxy is honoured so a trace survives the hop.
           */
          genReqId: (req: IncomingMessage, res: ServerResponse): string => {
            // The trace id, when a trace is running (ADR-0030): the correlation id on a 5xx opens the waterfall.
            const forwarded = req.headers["x-request-id"]
            // Honoured only in a shape a proxy would send: a 5xx echoes it, and the logs key on it.
            const id = typeof forwarded === "string" && REQUEST_ID.test(forwarded) ? forwarded : (activeTraceId() ?? randomUUID())
            res.setHeader("x-request-id", id)
            return id
          },

          /**
           * `orgId` on every line is what makes "which tenant is slow" an
           * answerable question (`ENGINEERING.md` §Logging). pino-http evaluates
           * this twice — when the request arrives, before any tenant is known,
           * and again when the response finishes, inside the request context —
           * so the completion line carries the tenant that resolution settled on.
           */
          customProps: () => {
            const orgId = tenantContext.current()?.orgId
            return orgId === undefined ? {} : { orgId }
          },

          // No PII, ever. Never emails, ticket bodies or credentials.
          redact: {
            paths: [
              "req.headers.authorization",
              "req.headers.cookie",
              "req.headers['x-patchgrid-tenant']",
              "res.headers['set-cookie']",
            ],
            remove: true,
          },

          serializers: {
            // The path only: a query string carries tokens and search text (M9 review).
            req: (req: { id: string; method: string; url: string }) => ({
              id: req.id,
              method: req.method,
              url: req.url.split("?")[0] ?? req.url,
            }),
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          },

          // Health probes fire every few seconds. Logging them drowns everything
          // that matters, and a readiness failure is reported by the probe itself.
          autoLogging: {
            ignore: (req: IncomingMessage) => req.url?.startsWith("/health") === true,
          },
        },
      }),
    }),
    // Order matters: the per-IP throttler guard registers before the tenant
    // resolution guard (pipeline steps 3 then 4).
    ThrottlingModule,
    TenancyModule,
    PrismaModule,
    RedisModule,
    AuthModule,
    AuthzModule,
    JobsModule,
    DispatchModule,
    MaintenanceModule,
    PurgeModule,
    ExportsModule,
    StorageModule,
    AssetsModule,
    AttachmentsModule,
    KnowledgeModule,
    InboundModule,
    BackofficeModule,
    SupportModule,
    ApiTokensModule,
    AuditModule,
    QuotaModule,
    MailModule,
    OrgsModule,
    MembershipsModule,
    TeamsModule,
    CategoriesModule,
    EventsModule,
    NotificationsModule,
    SlaModule,
    TicketsModule,
    WebhooksModule,
    DeadLettersModule,
    ReportingModule,
    ViewsModule,
    SsoModule,
    IdempotencyModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Request duration, transactions per request and the tenant on the span, measured on `finish` (ADR-0030).
    consumer.apply(TelemetryMiddleware).forRoutes("{*path}")
  }
}
