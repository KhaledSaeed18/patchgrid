import { Alert, AlertDescription } from "@patchgrid/ui/components/alert"

/** A form-level message: what went wrong and what to do about it. */
export function FormAlert({
  children,
  tone = "error",
}: {
  children: React.ReactNode
  tone?: "error" | "info"
}) {
  return (
    <Alert
      variant={tone === "error" ? "destructive" : "default"}
      role={tone === "error" ? "alert" : "status"}
    >
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}
