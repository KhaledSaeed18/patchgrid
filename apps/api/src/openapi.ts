import type { INestApplication } from "@nestjs/common"
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from "@nestjs/swagger"
import { ACCESS_COOKIE_PREFIX, REQUESTED_WITH, TENANT_HEADER } from "@patchgrid/contracts"
import { cleanupOpenApiDoc } from "nestjs-zod"

import type { AppConfig } from "./config/app-config"

/**
 * `/api/docs` (ENGINEERING.md §API conventions): the OpenAPI document built
 * from the controllers' Zod DTOs, so a shape that drifts from
 * `@patchgrid/contracts` drifts here too. Tags come from the path, not from
 * decorators on thirty controllers; the examples are the handful of requests a
 * first integration makes. Served without authentication: the document
 * describes the API and carries nothing of any tenant.
 */
export function serveOpenApi(app: INestApplication, config: AppConfig): void {
  const builder = new DocumentBuilder()
    .setTitle("Patchgrid API")
    .setVersion("1")
    .setDescription(DESCRIPTION)
    .addServer(`http://api.${config.ROOT_DOMAIN}${config.isProduction ? "" : `:${String(config.PORT)}`}/api/v1`, "This deployment")
    .addCookieAuth(
      `${ACCESS_COOKIE_PREFIX}<slug>`,
      {
        type: "apiKey",
        in: "cookie",
        description:
          "The workspace's access cookie, set by `POST /auth/login`. Sent with `Origin: https://<slug>.<root>` and `X-Requested-With: patchgrid` on writes.",
      },
      "session",
    )
    .addBearerAuth(
      {
        type: "http",
        scheme: "bearer",
        description:
          "An API token (`pg_<prefix>_<secret>`), minted under Settings → API tokens. Acts as its own service account, narrowed by its scopes.",
      },
      "token",
    )
  for (const tag of TAGS) builder.addTag(tag.name, tag.description)

  const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, builder.build(), { ignoreGlobalPrefix: true }))
  tagByPath(document)
  addExamples(document)
  SwaggerModule.setup("api/docs", app, document, {
    jsonDocumentUrl: "api/docs/openapi.json",
    customSiteTitle: "Patchgrid API",
    swaggerOptions: { tagsSorter: "alpha", operationsSorter: "alpha", defaultModelsExpandDepth: 0 },
  })
}

const DESCRIPTION = `Every request is for exactly one workspace, and the workspace comes from the credential, never from a parameter: a session cookie named after the workspace, or an API token bound to it. Nothing accepts an \`orgId\`.

Errors are RFC 9457 Problem Details with a \`type\` that resolves to an explanation: \`401\` not authenticated, \`403\` not permitted or wrong workspace, \`402\` only ever a plan limit, \`404\` unknown — or a record this caller may not see — \`409\` an invalid transition or a stale \`version\`. Priority is computed from impact and urgency and never accepted. Status changes go through \`POST /tickets/{id}/transitions\`. Entity-creating \`POST\`s honour \`Idempotency-Key\`. Browser clients send \`X-Requested-With: ${REQUESTED_WITH}\`; server-side callers may assert the workspace with \`${TENANT_HEADER}\` as a cross-check.`

const TAGS: { name: string; description: string; prefixes: string[] }[] = [
  { name: "Auth", description: "Sessions, the picker, second factors and step-up (ADR-0024, ADR-0045).", prefixes: ["/auth"] },
  {
    name: "Workspaces",
    description: "Creating a workspace, its settings, usage, export and deletion.",
    prefixes: ["/orgs", "/org/settings", "/org/usage", "/org/slug", "/org/deletion", "/org/exports", "/tenants"],
  },
  {
    name: "Members",
    description: "People, invitations, teams and the caller's own standing.",
    prefixes: ["/members", "/invitations", "/teams", "/me"],
  },
  {
    name: "Tickets",
    description: "Incidents, service requests, problems and changes: one lifecycle each, driven by transitions.",
    prefixes: ["/tickets", "/sla-policies", "/categories"],
  },
  { name: "Knowledge", description: "Articles, published and internal.", prefixes: ["/articles"] },
  { name: "Assets", description: "The asset register and what tickets are about.", prefixes: ["/assets"] },
  { name: "Attachments", description: "Presigned uploads and downloads on a separate origin (ADR-0037).", prefixes: ["/attachments"] },
  { name: "Notifications", description: "The bell, and the live stream.", prefixes: ["/notifications"] },
  {
    name: "Integrations",
    description: "API tokens, inbound mail and the audit log.",
    prefixes: ["/org/api-tokens", "/org/inbound-emails", "/org/audit", "/inbound"],
  },
  { name: "Support", description: "Owner-granted, read-only support sessions (ADR-0041).", prefixes: ["/org/support-sessions"] },
  { name: "Platform", description: "The operators' own credential and back-office (ADR-0040).", prefixes: ["/platform"] },
  { name: "Health", description: "Liveness and readiness.", prefixes: ["/health"] },
]

function tagByPath(document: OpenAPIObject): void {
  for (const [path, item] of Object.entries(document.paths)) {
    const tag = TAGS.find((t) => t.prefixes.some((p) => path === p || path.startsWith(`${p}/`)))?.name ?? "Other"
    for (const operation of Object.values(item) as { tags?: string[]; security?: unknown[] }[]) {
      if (typeof operation !== "object" || operation === null) continue
      operation.tags = [tag]
      operation.security ??= path.startsWith("/auth") || path.startsWith("/health") ? [] : [{ session: [] }, { token: [] }]
    }
  }
}

/** The requests a first integration makes, as examples on their operations. */
const EXAMPLES: Record<string, { method: string; example: unknown }> = {
  "/auth/login": { method: "post", example: { email: "alice@acme.example", password: "correct horse battery staple", slug: "acme" } },
  "/tickets": {
    method: "post",
    example: {
      type: "INCIDENT",
      title: "VPN drops every hour",
      description: "Since this morning the tunnel resets on the hour.",
      impact: "MEDIUM",
      urgency: "HIGH",
    },
  },
  "/tickets/{id}/transitions": {
    method: "post",
    example: { action: "resolve", version: 3, comment: { body: "Replaced the concentrator's certificate.", visibility: "PUBLIC" } },
  },
  "/tickets/{id}/comments": { method: "post", example: { body: "Looking at it now.", visibility: "PUBLIC" } },
  "/invitations": { method: "post", example: { email: "new.hire@acme.example", role: "AGENT" } },
  "/org/api-tokens": {
    method: "post",
    example: { name: "Zabbix alerts", role: "AGENT", scopes: ["tickets:read", "tickets:write"], expiresInDays: 90 },
  },
}

function addExamples(document: OpenAPIObject): void {
  for (const [path, { method, example }] of Object.entries(EXAMPLES)) {
    const operation = (
      document.paths[path] as Record<string, { requestBody?: { content?: Record<string, { example?: unknown }> } }> | undefined
    )?.[method]
    const json = operation?.requestBody?.content?.["application/json"]
    if (json !== undefined) json.example = example
  }
}
