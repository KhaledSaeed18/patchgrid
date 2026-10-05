import { Button, FallbackLink, MailLayout } from "./layout"

export type InviteParams = {
  orgName: string
  inviterName: string
  role: string
  acceptUrl: string
  expiresInDays: number
}

/** Bound to the invited address: whoever accepts must be logged in as it (ADR-0031). */
export function Invite({ orgName, inviterName, role, acceptUrl, expiresInDays }: InviteParams) {
  return (
    <MailLayout preview={`${inviterName} invited you to ${orgName} on Patchgrid`}>
      <p>
        <strong>{inviterName}</strong> has invited you to join <strong>{orgName}</strong> on Patchgrid as a{" "}
        {role.toLowerCase()}.
      </p>
      <p>This invitation is for this address only and expires in {expiresInDays} days.</p>
      <Button href={acceptUrl}>Accept the invitation</Button>
      <FallbackLink href={acceptUrl} />
    </MailLayout>
  )
}
