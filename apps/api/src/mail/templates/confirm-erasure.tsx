import { Button, FallbackLink, MailLayout } from "./layout"

export type ConfirmErasureParams = { name: string; confirmUrl: string; expiresInMinutes: number }

/**
 * The link that erases an account (ADR-0044) for someone with no password to
 * type — an account a workspace's identity provider made. Asked for, never
 * sent unprompted; it works once.
 */
export function ConfirmErasure({ name, confirmUrl, expiresInMinutes }: ConfirmErasureParams) {
  return (
    <MailLayout preview="Erase your Patchgrid account">
      <p>Hi {name},</p>
      <p>
        Someone asked to erase the Patchgrid account at this address. The link below shows what erasing removes and asks you to
        confirm. It works once and expires in {expiresInMinutes} minutes.
      </p>
      <Button href={confirmUrl}>Review and erase</Button>
      <p>If you did not ask for this, ignore it: nothing happens until the link is used.</p>
      <FallbackLink href={confirmUrl} />
    </MailLayout>
  )
}
