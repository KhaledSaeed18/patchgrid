import { createCipheriv, randomBytes } from "node:crypto"

import type { PrismaClient } from "../src/index.ts"

/** The local Keycloak's realm and client (`docker/keycloak/acme-realm.json`), reached as http://localhost:8180. */
export const DEMO_SSO = {
  domain: "acme.test",
  issuer: "http://localhost:8180/realms/acme",
  clientId: "patchgrid",
  /** Shared with the realm file; local only, like every other value in it. */
  clientSecret: "patchgrid-local-sso",
} as const

/**
 * Acme signs in through the local Keycloak (ADR-0054): its domain marked
 * proved — there is no DNS zone to publish into locally, and the seed is the
 * owner role — and its connection enabled at the requester default, so
 * `kim@acme.test` is provisioned on first sign-in. Not required: Acme's seeded
 * people keep their passwords. Globex has no SSO; the lookalike rows go.
 *
 * Skipped without `SSO_SECRETS_KEY`, which seals the client secret the way
 * the API does (AES-256-GCM, `v1.<iv>.<tag>.<ciphertext>`).
 */
export async function seedDemoSso(db: PrismaClient, orgs: { acme: string; globex: string }): Promise<boolean> {
  await db.ssoIdentity.deleteMany({ where: { orgId: { in: [orgs.acme, orgs.globex] } } })
  await db.ssoConnection.deleteMany({ where: { orgId: { in: [orgs.acme, orgs.globex] } } })
  const key = process.env.SSO_SECRETS_KEY
  if (key === undefined || key === "") return false
  await db.organization.update({
    where: { id: orgs.acme },
    data: { domain: DEMO_SSO.domain, domainVerifiedAt: new Date(), domainChallenge: null },
  })
  await db.ssoConnection.create({
    data: {
      orgId: orgs.acme,
      issuer: DEMO_SSO.issuer,
      clientId: DEMO_SSO.clientId,
      clientSecretSealed: seal(DEMO_SSO.clientSecret, key),
      defaultRole: "REQUESTER",
      enabled: true,
    },
  })
  return true
}

function seal(plaintext: string, base64Key: string): string {
  const keyBytes = Buffer.from(base64Key, "base64")
  if (keyBytes.length !== 32) throw new Error("SSO_SECRETS_KEY must be base64 of exactly 32 bytes")
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", keyBytes, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  return ["v1", iv, cipher.getAuthTag(), ciphertext].map((part) => (typeof part === "string" ? part : part.toString("base64url"))).join(".")
}
