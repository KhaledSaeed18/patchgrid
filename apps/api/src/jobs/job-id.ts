/**
 * `<queue>:<orgId>:<entityId>:<discriminator>` (ADR-0018): idempotent per
 * tenant, collision-free across tenants. Platform jobs use `platform` where an
 * org would be, so the shape is one and the same everywhere.
 */
export function jobId(queue: string, orgId: string | null, entityId: string, discriminator: string): string {
  for (const part of [queue, entityId, discriminator]) {
    if (part === "" || part.includes(":")) throw new Error(`job id part ${JSON.stringify(part)} is empty or contains ':'`)
  }
  return `${queue}:${orgId ?? "platform"}:${entityId}:${discriminator}`
}
