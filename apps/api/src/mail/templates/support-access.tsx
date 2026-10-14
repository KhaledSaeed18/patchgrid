import { Button, FallbackLink, MailLayout } from "./layout"

export type SupportEvent = "requested" | "granted" | "first-use" | "ended"

export type SupportAccessParams = {
  orgName: string
  operatorName: string
  event: SupportEvent
  /** Why it ended, or until when it runs — said in words by the sender. */
  detail: string
  settingsUrl: string
}

const HEADLINE: Record<SupportEvent, (p: SupportAccessParams) => string> = {
  requested: (p) => `${p.operatorName} from Patchgrid support asked to read ${p.orgName}`,
  granted: (p) => `Patchgrid support can now read ${p.orgName}`,
  "first-use": (p) => `${p.operatorName} from Patchgrid support is reading ${p.orgName} now`,
  ended: (p) => `Patchgrid support's access to ${p.orgName} has ended`,
}

export function supportSubject(p: SupportAccessParams): string {
  return HEADLINE[p.event](p)
}

/**
 * To every owner, at each turn of a support session (ADR-0020): the request,
 * the grant, the first read, and the end. Read-only access to a workspace is
 * the most sensitive thing an operator can hold, so its owners hear about it
 * by email as well as in the product.
 */
export function SupportAccess(p: SupportAccessParams) {
  return (
    <MailLayout preview={HEADLINE[p.event](p)}>
      <p>
        <strong>{HEADLINE[p.event](p)}.</strong>
      </p>
      <p>{p.detail}</p>
      <p>
        A support session is read-only, and every page it opens is recorded in your workspace&apos;s audit log. Any owner can end it at once.
      </p>
      <Button href={p.settingsUrl}>Review support access</Button>
      <FallbackLink href={p.settingsUrl} />
    </MailLayout>
  )
}
