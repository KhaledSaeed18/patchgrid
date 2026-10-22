import {
  passkeyAssertionCredentialSchema,
  type PasskeyCreationCeremony,
  type PasskeyProof,
  passkeyRegistrationCredentialSchema,
  type PasskeyRegistrationCredential,
  passkeyRequestCeremonySchema,
} from "@patchgrid/contracts"
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser"

import { useSyncExternalStore } from "react"

import { clientApi } from "./api/client"

/**
 * Passkeys in the browser (ADR-0053): the two WebAuthn calls, wrapped so the
 * rest of the app speaks only the contracts' shapes. Every ceremony starts
 * from options the API issued, under a challenge it keeps.
 */

/**
 * WebAuthn exists only in secure contexts. Plain-http development hosts are
 * not one, so the button that cannot work is not shown (ADR-0053).
 */
export function passkeysAvailable(): boolean {
  return typeof window !== "undefined" && browserSupportsWebAuthn()
}

const never = () => () => undefined

/** `passkeysAvailable()` as a hook: `false` on the server and in the first render, the browser's answer after. */
export function usePasskeysAvailable(): boolean {
  return useSyncExternalStore(never, passkeysAvailable, () => false)
}

/** The person closed the browser's prompt, or no passkey on this device fits: nothing happened. */
export class PasskeyCancelled extends Error {
  constructor() {
    super("Passkey cancelled")
    this.name = "PasskeyCancelled"
  }
}

/**
 * An assertion against options from `optionsPath`: the passwordless login's,
 * the second step's, or a `pg_id` holder's proof. `anonymous` for the first
 * two, which have no session to refresh.
 */
export async function assertWithPasskey(
  optionsPath: string,
  anonymous = false
): Promise<PasskeyProof> {
  const ceremony = await clientApi(optionsPath, {
    method: "POST",
    anonymous,
    schema: passkeyRequestCeremonySchema,
  })
  const answer = await prompt(() =>
    startAuthentication({ optionsJSON: ceremony.options })
  )
  return {
    challengeId: ceremony.challengeId,
    credential: passkeyAssertionCredentialSchema.parse(answer),
  }
}

/** A new credential against creation options the API issued. */
export async function createPasskey(
  ceremony: PasskeyCreationCeremony
): Promise<PasskeyRegistrationCredential> {
  const answer = await prompt(() =>
    startRegistration({ optionsJSON: ceremony.options })
  )
  return passkeyRegistrationCredentialSchema.parse(answer)
}

/** Registration refused because this device already holds one of the person's passkeys. */
export class PasskeyAlreadyRegistered extends Error {
  constructor() {
    super("This device already has a passkey for your account")
    this.name = "PasskeyAlreadyRegistered"
  }
}

/** The browser's refusals mean "nothing happened"; anything else is a real failure. */
async function prompt<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof Error && error.name === "InvalidStateError")
      throw new PasskeyAlreadyRegistered()
    if (
      error instanceof Error &&
      (error.name === "NotAllowedError" || error.name === "AbortError")
    )
      throw new PasskeyCancelled()
    throw error
  }
}
