import { Button, FallbackLink, MailLayout } from "./layout"

export type ResetPasswordParams = { name: string; resetUrl: string; expiresInMinutes: number }

export function ResetPassword({ name, resetUrl, expiresInMinutes }: ResetPasswordParams) {
  return (
    <MailLayout preview="Reset your Patchgrid password">
      <p>Hi {name},</p>
      <p>Use the link below to choose a new password. It works once and expires in {expiresInMinutes} minutes.</p>
      <Button href={resetUrl}>Reset my password</Button>
      <p>If you did not ask for this, your password is unchanged and nothing else is needed.</p>
      <FallbackLink href={resetUrl} />
    </MailLayout>
  )
}
