import { z } from "zod"

/**
 * Priority is computed, never chosen (DOMAIN.md §3): impact × urgency through
 * one matrix. The API applies it to every ticket; the marketing site shows it
 * working. One definition, held to DOMAIN.md by a test.
 */
export const impactSchema = z.enum(["LOW", "MEDIUM", "HIGH"])
export type Impact = z.infer<typeof impactSchema>

export const urgencySchema = z.enum(["LOW", "MEDIUM", "HIGH"])
export type Urgency = z.infer<typeof urgencySchema>

export const prioritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"])
export type Priority = z.infer<typeof prioritySchema>

/** Rows are impact, columns urgency. */
export const PRIORITY_MATRIX = {
  HIGH: { LOW: "MEDIUM", MEDIUM: "HIGH", HIGH: "CRITICAL" },
  MEDIUM: { LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH" },
  LOW: { LOW: "LOW", MEDIUM: "LOW", HIGH: "MEDIUM" },
} as const satisfies Record<Impact, Record<Urgency, Priority>>

export function computePriority(impact: Impact, urgency: Urgency): Priority {
  return PRIORITY_MATRIX[impact][urgency]
}

/**
 * The SLA targets every workspace starts with, per priority (DOMAIN.md §4.1),
 * in minutes. Provisioning seeds them as editable policies in M2.
 */
export const DEFAULT_SLA_TARGETS = {
  CRITICAL: { response: 15, responseWarning: 5, resolution: 240, resolutionWarning: 45 },
  HIGH: { response: 30, responseWarning: 10, resolution: 480, resolutionWarning: 60 },
  MEDIUM: { response: 60, responseWarning: 15, resolution: 1440, resolutionWarning: 120 },
  LOW: { response: 240, responseWarning: 60, resolution: 4320, resolutionWarning: 240 },
} as const satisfies Record<
  Priority,
  { response: number; responseWarning: number; resolution: number; resolutionWarning: number }
>
