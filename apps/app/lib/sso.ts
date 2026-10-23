import {
  type SsoErrorCode,
  ssoErrorCodeSchema,
  type SsoIntent,
  ssoReturnPathSchema,
} from "@patchgrid/contracts"

import { API_URL } from "./config"

/**
 * The way into a workspace's identity provider (ADR-0054): a top-level
 * navigation to the API, which answers with a redirect to the provider and,
 * after it, to the workspace. Never fetched — the browser has to go there.
 */
export function ssoStartUrl(
  by: { email: string } | { slug: string },
  options: { intent?: SsoIntent; next?: string } = {}
): string {
  const query = new URLSearchParams(
    "email" in by ? { email: by.email } : { slug: by.slug }
  )
  if (options.intent !== undefined) query.set("intent", options.intent)
  // Only a path on the workspace host travels; anything else is dropped, not sent.
  if (
    options.next !== undefined &&
    ssoReturnPathSchema.safeParse(options.next).success
  )
    query.set("next", options.next)
  return `${API_URL}/auth/sso/start?${query.toString()}`
}

/** What came back in `?sso=`, if it is one of ours. */
export function ssoErrorFrom(
  value: string | string[] | null | undefined
): SsoErrorCode | null {
  const parsed = ssoErrorCodeSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** One plain sentence per code; the provider's own words are never shown (ADR-0054). */
export const SSO_ERROR_MESSAGE: Record<SsoErrorCode, string> = {
  "not-configured":
    "Single sign-on isn't set up for that workspace or address. Sign in with your password instead.",
  unavailable:
    "Your organization's sign-in service couldn't be reached. Try again in a moment.",
  denied:
    "Your organization's sign-in service didn't let you in, or the sign-in was cancelled.",
  expired:
    "That sign-in took too long or was opened in another browser. Start again.",
  email:
    "Your organization's sign-in service didn't vouch for an address at the workspace's domain.",
  inactive:
    "Your access to that workspace is paused or was removed. Ask one of its admins.",
  seat: "The workspace has no seats left for a new member. Ask one of its admins.",
  mismatch:
    "You confirmed as someone else at your organization's sign-in service. Sign in again as yourself.",
  stale:
    "Your organization's sign-in service didn't ask you to sign in again. Try once more.",
  owner:
    "Owners confirm this with their own Patchgrid sign-in, not the organization's. Sign in with your password or passkey, then try again.",
  foreign:
    "That sign-in didn't start from Patchgrid. Start again from this page.",
}
