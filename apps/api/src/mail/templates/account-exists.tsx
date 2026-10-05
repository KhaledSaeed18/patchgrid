import { Button, FallbackLink, MailLayout } from "./layout"

export type AccountExistsParams = { name: string; loginUrl: string; resetUrl: string }

/**
 * Signup for an address that already has an account. The response was the same
 * `202` as for a new address; this is where the difference goes (ADR-0031).
 */
export function AccountExists({ name, loginUrl, resetUrl }: AccountExistsParams) {
  return (
    <MailLayout preview="You already have a Patchgrid account">
      <p>Hi {name},</p>
      <p>Someone — probably you — tried to sign up for Patchgrid with this address, but it already has an account.</p>
      <Button href={loginUrl}>Log in</Button>
      <p>
        Forgotten your password? <a href={resetUrl} style={{ color: "#e86a1a" }}>Reset it here</a>.
      </p>
      <FallbackLink href={loginUrl} />
    </MailLayout>
  )
}
