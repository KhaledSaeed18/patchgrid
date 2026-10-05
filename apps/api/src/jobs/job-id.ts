/**
 * `<queue>/<orgId>/<entityId>/<discriminator>` — ADR-0018's shape with `/`
 * where it wrote `:`, because BullMQ reserves `:` in its own keys and refuses
 * a custom id containing one (ADR-0018 erratum). Idempotent per tenant,
 * collision-free across tenants; platform jobs use `platform` where an org
 * would be, so the shape is one and the same everywhere.
 */
export const JOB_ID_SEPARATOR = "/"

export function jobId(queue: string, orgId: string | null, entityId: string, discriminator: string): string {
  for (const part of [queue, entityId, discriminator]) {
    if (part === "" || part.includes(JOB_ID_SEPARATOR) || part.includes(":")) {
      throw new Error(`job id part ${JSON.stringify(part)} is empty or contains a reserved character`)
    }
  }
  return [queue, orgId ?? "platform", entityId, discriminator].join(JOB_ID_SEPARATOR)
}
