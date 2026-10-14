import { MailLayout } from "./layout"

export type AccountErasedParams = { workspaceCount: number }

export function accountErasedSubject(): string {
  return "Your Patchgrid account has been deleted"
}

/**
 * The last mail to this address (ADR-0044), sent from memory: by the time it
 * is queued, the account no longer has it.
 */
export function AccountErased(p: AccountErasedParams) {
  return (
    <MailLayout preview={accountErasedSubject()}>
      <p>
        <strong>{accountErasedSubject()}.</strong>
      </p>
      <p>
        Your name and address are gone from it
        {p.workspaceCount > 0 ? ` and from the ${String(p.workspaceCount)} workspace${p.workspaceCount === 1 ? "" : "s"} you were in` : ""}. What you wrote in
        tickets stays with those workspaces, under &ldquo;Former member&rdquo;.
      </p>
      <p>You can sign up again with this address at any time; it starts a new, empty account.</p>
    </MailLayout>
  )
}
