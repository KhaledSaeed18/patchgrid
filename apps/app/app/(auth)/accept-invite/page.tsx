import { Placeholder } from "@/components/placeholder"

export default function AcceptInvitePage() {
  return (
    <Placeholder surface="auth" milestone="M1">
      Invitation tokens carry their organization (
      <code>&lt;orgId&gt;.&lt;secret&gt;</code>) so the API can establish tenant
      context before looking the invitation up — a wrong org and a wrong secret
      fail identically (ADR-0022).
    </Placeholder>
  )
}
