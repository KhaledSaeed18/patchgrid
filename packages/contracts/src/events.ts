import { z } from "zod"

import { idSchema } from "./id.ts"

/** Every reader of a tenant's event log (ADR-0049). A cursor row is keyed on the name, so a name is forever. */
export const eventConsumerSchema = z.enum(["notify", "webhooks", "reporting"])
export type EventConsumerName = z.infer<typeof eventConsumerSchema>

/**
 * An event a consumer gave up on (ADR-0049): parked after repeated failures,
 * with the error it last failed with. `replayedAt` is set once an admin has
 * run it through its consumer again and it went through.
 */
export const deadLetterSchema = z.object({
  id: idSchema,
  consumer: eventConsumerSchema,
  eventId: idSchema,
  eventType: z.string(),
  occurredAt: z.iso.datetime(),
  failures: z.number().int().nonnegative(),
  error: z.string(),
  parkedAt: z.iso.datetime(),
  replayedAt: z.iso.datetime().nullable(),
})
export type DeadLetter = z.infer<typeof deadLetterSchema>

/** The most recent first; those still waiting for a replay before those done. */
export const deadLetterListSchema = z.object({ items: z.array(deadLetterSchema) })
export type DeadLetterList = z.infer<typeof deadLetterListSchema>
