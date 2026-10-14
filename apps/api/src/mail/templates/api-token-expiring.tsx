import { Button, FallbackLink, MailLayout } from "./layout"

export type ApiTokenExpiringParams = {
  orgName: string
  tokenName: string
  prefix: string
  /** When it lapses, said in words by the sender. */
  expiresOn: string
  settingsUrl: string
}

export function apiTokenExpiringSubject(p: ApiTokenExpiringParams): string {
  return `The API token "${p.tokenName.replace(/[\r\n]+/g, " ")}" in ${p.orgName} expires ${p.expiresOn}`
}

/**
 * A week before a token lapses (ADR-0042), to whoever created it — or the
 * owners, once they no longer can act on it. An integration that stops
 * without warning is an outage someone has to diagnose.
 */
export function ApiTokenExpiring(p: ApiTokenExpiringParams) {
  return (
    <MailLayout preview={apiTokenExpiringSubject(p)}>
      <p>
        <strong>{apiTokenExpiringSubject(p)}.</strong>
      </p>
      <p>
        Whatever uses <code>pg_{p.prefix}_…</code> will be refused from then on. Create a new token and swap it in before that date; a token&apos;s
        lifetime cannot be extended.
      </p>
      <Button href={p.settingsUrl}>Review API tokens</Button>
      <FallbackLink href={p.settingsUrl} />
    </MailLayout>
  )
}
