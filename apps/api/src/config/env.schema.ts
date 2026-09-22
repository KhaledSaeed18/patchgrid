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

    if (env.NODE_ENV === "production" && env.WEB_ORIGIN_PORTS.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["WEB_ORIGIN_PORTS"],
        message: "WEB_ORIGIN_PORTS must be empty in production; origins carry no port there",
      })
    }
  })

export type Env = z.infer<typeof envSchema>
