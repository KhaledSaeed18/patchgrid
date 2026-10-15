import { Button } from "@patchgrid/ui/components/button"

/** Shown once, when a factor is confirmed or the codes are replaced (ADR-0029). */
export function RecoveryCodes({
  codes,
  onDone,
  doneLabel = "I've saved them — continue",
}: {
  codes: string[]
  onDone: () => void
  doneLabel?: string
}) {
  return (
    <div className="grid gap-4">
      <p className="text-sm text-pretty">
        These recovery codes each sign you in once if you lose your
        authenticator. <strong>They are shown only now.</strong> Keep them
        somewhere safe.
      </p>
      <ul
        aria-label="Recovery codes"
        className="grid grid-cols-2 gap-2 rounded-lg border border-border p-4 font-mono text-sm"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <Button size="lg" onClick={onDone}>
        {doneLabel}
      </Button>
    </div>
  )
}
