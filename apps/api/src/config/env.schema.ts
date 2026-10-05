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
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),

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

    /** The application role. Holds neither BYPASSRLS nor CREATE (ADR-0022). */
    DATABASE_URL: url("DATABASE_URL"),
    /**
     * The migration role, which *does* hold BYPASSRLS. Present so the API can
     * refuse to start when someone points both at the same role — see below.
     */
    DATABASE_MIGRATION_URL: url("DATABASE_MIGRATION_URL"),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

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

    S3_ENDPOINT: url("S3_ENDPOINT"),
    S3_REGION: z.string().min(1).default("us-east-1"),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),

    SMTP_HOST: z.string().min(1).default("localhost"),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
    MAIL_FROM: z.string().min(1).default("Patchgrid <notifications@patchgrid.test>"),
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
          "DATABASE_URL must not equal DATABASE_MIGRATION_URL — the migration role holds BYPASSRLS " +
          "and would ignore every row-level security policy",
      })
    }

    if (env.COOKIE_DOMAIN !== `.${env.ROOT_DOMAIN}`) {
      ctx.addIssue({
        code: "custom",
        path: ["COOKIE_DOMAIN"],
        message: `COOKIE_DOMAIN must be .${env.ROOT_DOMAIN} — the cookies must be readable by api.${env.ROOT_DOMAIN}`,
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
