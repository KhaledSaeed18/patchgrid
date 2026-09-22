import { Placeholder } from "@/components/placeholder"

export default function LoginPage() {
  return (
    <Placeholder surface="auth" milestone="M1">
      Email and password, then a redirect to the workspace picker. The session
      is a short-lived access token plus a rotating refresh token in per-tenant
      httpOnly cookies, so two workspaces can be open in two tabs (ADR-0024).
    </Placeholder>
  )
}
