import { Placeholder } from "@/components/placeholder"

export default function ResetPasswordPage() {
  return (
    <Placeholder surface="auth" milestone="M1">
      Single-use emailed token, hashed at rest. Completing a reset bumps the
      revocation epoch, so every existing session ends immediately rather than
      lingering for the access token&apos;s lifetime.
    </Placeholder>
  )
}
