import { REQUESTED_WITH } from "@patchgrid/contracts"
import type { z } from "zod"

import { API_URL } from "@/lib/config"

import { toApiError } from "./errors"

/** One API call: the method, an optional JSON body, and the schema its answer must satisfy. */
export type Call<S extends z.ZodType | null> = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
  body?: unknown
  /** `null` for a `204`. */
  schema: S
  /** Sent on entity-creating POSTs (ADR-0012), so a retried create is not a second one. */
  idempotencyKey?: string
}

export type Result<S extends z.ZodType | null> = S extends z.ZodType
  ? z.infer<S>
  : undefined

/** What both clients share: the URL, the CSRF header, the JSON body, parsing the answer. */
export function buildRequest(
  path: string,
  call: Call<z.ZodType | null>,
  headers: Headers
): [string, RequestInit] {
  headers.set("X-Requested-With", REQUESTED_WITH)
  if (call.body !== undefined) headers.set("Content-Type", "application/json")
  if (call.idempotencyKey !== undefined)
    headers.set("Idempotency-Key", call.idempotencyKey)
  return [
    `${API_URL}${path}`,
    {
      method: call.method ?? "GET",
      headers,
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
    },
  ]
}

export async function readResult<S extends z.ZodType | null>(
  response: Response,
  schema: S
): Promise<Result<S>> {
  if (!response.ok) throw await toApiError(response)
  if (schema === null || response.status === 204) return undefined as Result<S>
  // The contract is checked on both ends: a drift fails here, loudly, not three components later.
  return schema.parse(await response.json()) as Result<S>
}
