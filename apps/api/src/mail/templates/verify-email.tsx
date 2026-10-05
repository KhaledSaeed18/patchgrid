import { Button, FallbackLink, MailLayout } from "./layout"

export type VerifyEmailParams = { name: string; verifyUrl: string; expiresInHours: number }

/** Completes signup and starts the session (ADR-0031). */
export function VerifyEmail({ name, verifyUrl, expiresInHours }: VerifyEmailParams) {
  return (
    <MailLayout preview="Verify your address to finish setting up Patchgrid">
      <p>Hi {name},</p>
      <p>Confirm this address to finish creating your Patchgrid account. The link is good for {expiresInHours} hours.</p>
      <Button href={verifyUrl}>Verify my address</Button>
      <FallbackLink href={verifyUrl} />
    </MailLayout>
  )
}
