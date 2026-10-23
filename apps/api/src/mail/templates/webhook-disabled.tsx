import { Button, FallbackLink, MailLayout } from "./layout"

export type WebhookDisabledParams = {
  orgName: string
  /** Where it was sending, shown as text: the admins chose it, and the mail must not make it a link. */
  endpointUrl: string
  reason: string
  settingsUrl: string
}

export function webhookDisabledSubject(p: WebhookDisabledParams): string {
  return `A webhook in ${p.orgName} was turned off`
}

/**
 * To the workspace's admins and owners when an endpoint is turned off for
 * failing too long (ADR-0050). Nothing else would tell them: the integration
 * on the other end simply stops hearing from Patchgrid.
 */
export function WebhookDisabled(p: WebhookDisabledParams) {
  return (
    <MailLayout preview={webhookDisabledSubject(p)}>
      <p>
        <strong>{webhookDisabledSubject(p)}.</strong>
      </p>
      <p>
        The webhook sending to <code>{p.endpointUrl}</code> has stopped: {p.reason.toLowerCase()}. Whatever listens there has heard nothing
        from Patchgrid since. Fix the receiver, turn the webhook back on, and replay the deliveries it missed.
      </p>
      <Button href={p.settingsUrl}>Review the webhook</Button>
      <FallbackLink href={p.settingsUrl} />
    </MailLayout>
  )
}
