import { FormAlert } from "@/components/form-alert"
import { ROOT_DOMAIN } from "@/lib/config"

/**
 * An SSO session vouches for one workspace, not for the account (ADR-0054):
 * the API refuses every account change it asks for. Say so up front, rather
 * than letting each button fail.
 */
export function SsoSessionNotice({ slug }: { slug: string }) {
  return (
    <FormAlert tone="info">
      You signed in through the single sign-on of{" "}
      <span className="font-mono">
        {slug}.{ROOT_DOMAIN}
      </span>
      . It vouches for that workspace only, so changes to your Patchgrid account
      — its password, passkeys, two-factor authentication or erasure — need your
      own Patchgrid sign-in.{" "}
      <a href="/login" className="underline underline-offset-4">
        Sign in with your email and password
      </a>
      .
    </FormAlert>
  )
}
