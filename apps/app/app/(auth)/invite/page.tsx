import { invitationPreviewSchema } from "@patchgrid/contracts"
import type { Metadata } from "next"
import Link from "next/link"

import { AuthShell } from "@/components/auth-shell"
import { FormAlert } from "@/components/form-alert"
import { serverIdentity } from "@/lib/api/server"
import { API_URL, ROOT_DOMAIN } from "@/lib/config"

import { AcceptAsMember, CreateAccountAndJoin } from "./accept"

export const metadata: Metadata = { title: "Join a workspace" }

const ROLE_NAMES = {
  OWNER: "an owner",
  ADMIN: "an admin",
  AGENT: "an agent",
  REQUESTER: "a requester",
} as const

/**
 * The invitation link (TENANCY.md §5, ADR-0033). Signed in: join with one
 * click — the API checks the address. Signed out with an account: sign in and
 * come back. No account: create one here, verified by the link itself.
 */
export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { token } = await searchParams
  const preview = typeof token === "string" ? await previewOf(token) : null

  if (typeof token !== "string" || preview === null) {
    return (
      <AuthShell title="This invitation can't be used">
        <FormAlert>
          The link has expired, was already used, or was replaced by a newer
          invitation. Ask whoever invited you to send it again.
        </FormAlert>
      </AuthShell>
    )
  }

  const identity = await serverIdentity()
  const here = `/invite?token=${encodeURIComponent(token)}`
  return (
    <AuthShell
      title={`Join ${preview.organization.name}`}
      description={
        <>
          You&rsquo;re invited to join as {ROLE_NAMES[preview.role]}. The
          workspace lives at{" "}
          <span className="font-mono text-foreground">
            {preview.organization.slug}.{ROOT_DOMAIN}
          </span>
          .
        </>
      }
    >
      {identity !== null ? (
        <AcceptAsMember token={token} email={identity.user.email} />
      ) : preview.accountExists ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            This address already has a Patchgrid account. Sign in to accept.
          </p>
          <Link
            href={`/login?next=${encodeURIComponent(here)}`}
            className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground"
          >
            Sign in to accept
          </Link>
        </div>
      ) : (
        <CreateAccountAndJoin token={token} />
      )}
    </AuthShell>
  )
}

/** Public, and a bad token is simply "no preview"; nothing here needs a session. */
async function previewOf(token: string) {
  const response = await fetch(
    `${API_URL}/invitations/preview?token=${encodeURIComponent(token)}`,
    {
      cache: "no-store",
    }
  )
  if (!response.ok) return null
  const parsed = invitationPreviewSchema.safeParse(await response.json())
  return parsed.success ? parsed.data : null
}
