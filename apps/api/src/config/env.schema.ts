import { z } from "zod"

/**
 * Environment contract.
 *
 * Validated once, at boot. The process **refuses to start** on anything missing
 * or malformed, because the alternative is discovering it from a 500 at 3am with
 * a stack trace that names something unrelated.
 *
 * `.env.example` at the repository root is the human-readable companion to this
 * schema; the two are kept in step by the fact that a missing variable fails boot.
 */

const url = (label: string) => z.url({ error: `${label} must be a URL` })

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

    /**
     * The registrable domain tenants live under — `patchgrid.xyz` in production,
     * `lvh.me` locally. Every CORS decision is derived from this, so it is not a
     * cosmetic setting: widening it widens who may call the API with credentials.
     */
    ROOT_DOMAIN: z.string().min(3).default("lvh.me"),

    /**
     * Ports the browser surfaces are served on in development. Empty in
     * production, where origins carry no port.
     */
    WEB_ORIGIN_PORTS: z
      .string()
      .default("3000,3001")
      .transform((value) =>
        value
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part !== "")
          .map(Number),
      )
      .pipe(z.array(z.int().min(1).max(65535))),

    /** The application role. Holds neither BYPASSRLS nor CREATE, and is no member of the owner (ADR-0022, ADR-0059). */
    DATABASE_URL: url("DATABASE_URL"),
    /**
     * The migration role, which owns the tables and is therefore exempt from
     * their policies (ADR-0059). Present so the API can
     * refuse to start when someone points both at the same role — see below.
     */
    DATABASE_MIGRATION_URL: url("DATABASE_MIGRATION_URL"),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    /**
     * The outbox wake's dedicated `LISTEN` connection (ADR-0049), as the same
     * application role. `LISTEN` belongs to a session, so behind a pooler in
     * transaction mode it must reach the database directly; unset, it is
     * DATABASE_URL, which is the database itself when nothing pools.
     */
    DATABASE_LISTEN_URL: url("DATABASE_LISTEN_URL").optional(),

    REDIS_URL: url("REDIS_URL"),

    /**
     * Signs the access token (HS256). 32 bytes minimum: shorter and the token
     * is brute-forceable offline. Rotating it logs every session out, which is
     * the intended lever for a suspected leak.
     */
    JWT_SECRET: z.string().min(32, { error: "JWT_SECRET must be at least 32 characters" }),
    /** 15 minutes (ADR-0024): bounded by the revocation epoch, not a security limit. */
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    /** Tenant refresh tokens and pg_id alike (ADR-0031). */
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),
    /**
     * The domain every session cookie is issued for — `.patchgrid.xyz`, or
     * `.lvh.me` locally — so `app.`, `<slug>.` and `api.` share them
     * (ADR-0024). Must be the root domain with a leading dot.
     */
    COOKIE_DOMAIN: z
      .string()
      .regex(/^\.[a-z0-9.-]+$/, { error: "COOKIE_DOMAIN must be a dotted domain such as .lvh.me" })
      .default(".lvh.me"),

    /**
     * Where the API reaches object storage. Unset on AWS, where the SDK resolves
     * the regional endpoint (or AWS_ENDPOINT_URL_S3 / AWS_ENDPOINT_URL, which is
     * how an emulator is named without a line of code knowing it).
     */
    S3_ENDPOINT: url("S3_ENDPOINT").optional(),
    S3_REGION: z.string().min(1).default("us-east-1"),
    S3_BUCKET: z.string().min(1),
    /**
     * Static keys, for MinIO. Unset, the SDK's default chain supplies them: the
     * ECS task role on AWS, which is the only credential a deployment should
     * hold. Both or neither.
     */
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    /** MinIO and emulators address buckets by path; AWS prefers the bucket in the host. */
    S3_FORCE_PATH_STYLE: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    /**
     * Where browsers reach attachments: presigned URLs are minted against
     * this origin, which must be its own registrable domain — never under
     * ROOT_DOMAIN — so an uploaded file is never same-site with a session
     * (ADR-0037). MinIO at localhost:9000 in development.
     */
    FILES_PUBLIC_ORIGIN: url("FILES_PUBLIC_ORIGIN").default("http://localhost:9000"),

    /**
     * Which `MailProvider` sends: SMTP (Mailpit locally) or SES, through the
     * SDK's default credentials and region (ADR-0058).
     */
    MAIL_TRANSPORT: z.enum(["smtp", "ses"]).default("smtp"),
    SMTP_HOST: z.string().min(1).default("localhost"),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
    /** The envelope sender. The display name is replaced per tenant (ADR-0018). */
    MAIL_FROM: z
      .string()
      .regex(/^.+ <[^<>@\s]+@[^<>@\s]+>$/, { error: 'MAIL_FROM must look like "Name <address>"' })
      .default("Patchgrid <notifications@patchgrid.test>"),

    /**
     * The inbound mail webhook's signing secret, Standard Webhooks form
     * (`whsec_` + base64 of at least 24 bytes). Shared with whatever forwards
     * mail to `POST /inbound/email` (ADR-0039).
     */
    INBOUND_WEBHOOK_SECRET: z
      .string()
      .regex(/^whsec_[A-Za-z0-9+/]{32,}={0,2}$/, { error: "INBOUND_WEBHOOK_SECRET must be whsec_ followed by base64 of 24+ bytes" }),
    /**
     * The authserv-id of the MTA that receives tenant mail. Only an
     * Authentication-Results header carrying it is the verdict; any other is
     * the sender's own claim (ADR-0039, RFC 8601).
     */
    /**
     * Encrypts second-factor secrets at rest (ADR-0029, ADR-0040): base64 of
     * exactly 32 bytes, kept apart from the database, so a dump alone yields
     * no factors.
     */
    MFA_ENCRYPTION_KEY: z.string().refine((value) => /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, "base64").length === 32, {
      error: "MFA_ENCRYPTION_KEY must be base64 of exactly 32 bytes",
    }),
    /**
     * Seals webhook signing secrets at rest (ADR-0050). We sign with them, so
     * they cannot be hashed; base64 of exactly 32 bytes, kept apart from the
     * database like the MFA key, so a dump alone signs nothing.
     */
    WEBHOOK_SECRETS_KEY: z.string().refine((value) => /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, "base64").length === 32, {
      error: "WEBHOOK_SECRETS_KEY must be base64 of exactly 32 bytes",
    }),
    /**
     * Lets webhooks reach private and loopback addresses, over http — local
     * development only, where the receiver is on this machine. Refused in
     * production (ADR-0050, SSRF).
     */
    WEBHOOK_ALLOW_PRIVATE_TARGETS: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    /**
     * Seals SSO client secrets at rest (ADR-0054). We present them to the
     * identity provider, so they cannot be hashed; base64 of exactly 32
     * bytes, kept apart from the database like the other two keys.
     */
    SSO_SECRETS_KEY: z.string().refine((value) => /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, "base64").length === 32, {
      error: "SSO_SECRETS_KEY must be base64 of exactly 32 bytes",
    }),
    /**
     * Lets an SSO issuer be a private or loopback address, over http — the
     * local Keycloak only. Refused in production (ADR-0054, SSRF).
     */
    SSO_ALLOW_PRIVATE_ISSUERS: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    /**
     * Nameservers the domain proof asks (ADR-0054), as `ip` or `ip:port`,
     * comma-separated. Unset: the system's. A local resolver can stand in for
     * DNS no one can publish to.
     */
    DNS_RESOLVERS: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part !== ""),
      ),
    INBOUND_AUTHSERV_ID: z.string().regex(/^[A-Za-z0-9.-]+$/, { error: "INBOUND_AUTHSERV_ID must be a host name" }),

    /**
     * Which halves of the process run. `all` locally; `api` and `worker` let
     * the deployables split later without a code change (ARCHITECTURE.md
     * §Background jobs). Processors are always registered and only RUN in
     * `all` and `worker`.
     */
    WORKER_MODE: z.enum(["all", "api", "worker"]).default("all"),
    /**
     * Rate limiting (pipeline steps 3 and 6). Off only for integration specs that
     * drive one endpoint hundreds of times; never off where the API is reachable.
     * A string enum rather than `z.coerce.boolean()`, which would read "false" as true.
     */
    THROTTLE_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    /**
     * How many proxies stand between the internet and this process, counted
     * from it — Express's `trust proxy` hop count, applied in production only.
     * Too low and every client shares the proxy's address; too high and the
     * client chooses its own, so every per-IP limit is spent or dodged at will
     * (THREAT-MODEL.md §7). One for a single ingress; one more for each CDN or
     * load balancer in front of it.
     */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
    /**
     * The port `apps/app` is served on in development, for links in outbound
     * mail. Ignored in production, where links carry no port.
     */
    WEB_APP_PORT: z.coerce.number().int().min(1).max(65535).default(3001),

    /**
     * Where traces and metrics go (ADR-0030): an OTLP/HTTP collector, such as
     * the one `docker compose --profile observability up` runs. Unset means
     * off — the SDK does not start and every span and metric is a no-op.
     * Read by `startTelemetry` before this schema runs; listed here so a
     * typo fails boot like any other setting.
     */
    OTEL_EXPORTER_OTLP_ENDPOINT: url("OTEL_EXPORTER_OTLP_ENDPOINT").optional(),
    OTEL_SERVICE_NAME: z.string().min(1).default("patchgrid-api"),
  })
  .superRefine((env, ctx) => {
    // The single most damaging misconfiguration available: running the
    // application as the migration role silently disables every tenant policy
    // in the database. Cheap to check, catastrophic to miss (ADR-0015).
    if (env.DATABASE_URL === env.DATABASE_MIGRATION_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message:
          "DATABASE_URL must not equal DATABASE_MIGRATION_URL — the migration role owns the tables " +
          "and is exempt from every row-level security policy",
      })
    }

    if ((env.S3_ACCESS_KEY_ID === undefined) !== (env.S3_SECRET_ACCESS_KEY === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["S3_ACCESS_KEY_ID"],
        message: "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY go together — set both, or neither to use the default credential chain",
      })
    }

    // The wake listens as the application, never as anyone above it.
    if (env.DATABASE_LISTEN_URL !== undefined && new URL(env.DATABASE_LISTEN_URL).username !== new URL(env.DATABASE_URL).username) {
      ctx.addIssue({
        code: "custom",
        path: ["DATABASE_LISTEN_URL"],
        message: "DATABASE_LISTEN_URL must connect as the same role as DATABASE_URL",
      })
    }

    // ADR-0037: a files origin under the root domain receives every session
    // cookie, and anything active it served could toss one. Refuse to start.
    const filesHost = new URL(env.FILES_PUBLIC_ORIGIN).hostname
    if (filesHost === env.ROOT_DOMAIN || filesHost.endsWith(`.${env.ROOT_DOMAIN}`)) {
      ctx.addIssue({
        code: "custom",
        path: ["FILES_PUBLIC_ORIGIN"],
        message: `FILES_PUBLIC_ORIGIN must be its own registrable domain, not under ${env.ROOT_DOMAIN} — attachments would be same-site with every session`,
      })
    }

    if (env.COOKIE_DOMAIN !== `.${env.ROOT_DOMAIN}`) {
      ctx.addIssue({
        code: "custom",
        path: ["COOKIE_DOMAIN"],
        message: `COOKIE_DOMAIN must be .${env.ROOT_DOMAIN} — the cookies must be readable by api.${env.ROOT_DOMAIN}`,
      })
    }

    if (env.NODE_ENV !== "production" && !env.WEB_ORIGIN_PORTS.includes(env.WEB_APP_PORT)) {
      ctx.addIssue({
        code: "custom",
        path: ["WEB_APP_PORT"],
        message: "WEB_APP_PORT must be one of WEB_ORIGIN_PORTS, or links in mail would point at an origin CORS refuses",
      })
    }

    if (env.NODE_ENV === "production" && env.WEBHOOK_ALLOW_PRIVATE_TARGETS) {
      ctx.addIssue({
        code: "custom",
        path: ["WEBHOOK_ALLOW_PRIVATE_TARGETS"],
        message: "WEBHOOK_ALLOW_PRIVATE_TARGETS must be false in production — webhooks could reach the internal network",
      })
    }

    if (env.NODE_ENV === "production" && env.SSO_ALLOW_PRIVATE_ISSUERS) {
      ctx.addIssue({
        code: "custom",
        path: ["SSO_ALLOW_PRIVATE_ISSUERS"],
        message: "SSO_ALLOW_PRIVATE_ISSUERS must be false in production — a tenant's issuer could reach the internal network",
      })
    }

    if (env.NODE_ENV === "production" && env.WEB_ORIGIN_PORTS.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["WEB_ORIGIN_PORTS"],
        message: "WEB_ORIGIN_PORTS must be empty in production; origins carry no port there",
      })
    }
  })

export type Env = z.infer<typeof envSchema>
