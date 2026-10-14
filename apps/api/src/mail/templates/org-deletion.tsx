import { Button, FallbackLink, MailLayout } from "./layout"

export type OrgDeletionEvent = "requested" | "cancelled"

export type OrgDeletionParams = {
  orgName: string
  event: OrgDeletionEvent
  /** Who did it, as the workspace knows them — or "Patchgrid support". */
  actorName: string
  /** When the purge runs, said in words by the sender. */
  purgeOn: string
  /** The workspace picker, where an owner cancels. */
  workspacesUrl: string
}

export function orgDeletionSubject(p: OrgDeletionParams): string {
  return p.event === "requested" ? `${p.orgName} will be deleted ${p.purgeOn}` : `${p.orgName} will not be deleted`
}

/**
 * To every owner and admin when a workspace's deletion is requested, and
 * again if it is cancelled (ADR-0043). Thirty days is only a safety net if
 * the people who would object hear about it on day one.
 */
export function OrgDeletion(p: OrgDeletionParams) {
  return (
    <MailLayout preview={orgDeletionSubject(p)}>
      <p>
        <strong>{orgDeletionSubject(p)}.</strong>
      </p>
      {p.event === "requested" ? (
        <>
          <p>
            {p.actorName} asked for {p.orgName} to be deleted. Nobody can use it from now on. {p.purgeOn[0]?.toUpperCase()}
            {p.purgeOn.slice(1)}, its tickets, files, assets, articles and audit log are erased for good.
          </p>
          <p>Until then any owner can cancel this from the workspace list, and everything comes back as it was.</p>
        </>
      ) : (
        <p>{p.actorName} cancelled the deletion. The workspace is back as it was; sign in again to use it.</p>
      )}
      <Button href={p.workspacesUrl}>Open your workspaces</Button>
      <FallbackLink href={p.workspacesUrl} />
    </MailLayout>
  )
}
