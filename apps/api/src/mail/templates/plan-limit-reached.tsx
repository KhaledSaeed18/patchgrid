import { Button, FallbackLink, MailLayout } from "./layout"

export type PlanLimitReachedParams = {
  orgName: string
  /** What is full, in the plan's words: "The FREE plan's agent seats are all in use". */
  headline: string
  usageUrl: string
  preferencesUrl: string
}

export function planLimitReachedSubject(p: PlanLimitReachedParams): string {
  return `${p.orgName}: ${p.headline}`
}

/**
 * To the workspace's admins and owners, when usage reaches a plan limit
 * (DOMAIN.md §8). What it stops is the next of that thing; nothing existing
 * is touched (TENANCY.md §8). A platform admin changes the plan (ADR-0047).
 */
export function PlanLimitReached(p: PlanLimitReachedParams) {
  return (
    <MailLayout preview={planLimitReachedSubject(p)}>
      <p>
        <strong>{p.headline}.</strong>
      </p>
      <p>
        Nothing in {p.orgName} is lost or locked; what reached the limit just cannot grow until there is room again — by freeing some, or by
        moving the workspace to a larger plan.
      </p>
      <Button href={p.usageUrl}>See the workspace's usage</Button>
      <FallbackLink href={p.usageUrl} />
      <p style={{ fontSize: "12px", color: "#6b7280" }}>
        You get this as an admin of {p.orgName}. Choose which emails you get at {p.preferencesUrl}.
      </p>
    </MailLayout>
  )
}
