import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@patchgrid/ui/components/field"
import { Input } from "@patchgrid/ui/components/input"

/** A labelled input with its description and its error, wired for assistive technology. */
export function FormField({
  id,
  label,
  description,
  error,
  ...input
}: React.ComponentProps<typeof Input> & {
  id: string
  label: string
  description?: React.ReactNode
  error?: string | undefined
}) {
  return (
    <Field data-invalid={error !== undefined ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        aria-invalid={error !== undefined ? true : undefined}
        aria-describedby={error !== undefined ? `${id}-error` : undefined}
        {...input}
      />
      {description !== undefined && error === undefined && (
        <FieldDescription>{description}</FieldDescription>
      )}
      {error !== undefined && (
        <FieldError id={`${id}-error`}>{error}</FieldError>
      )}
    </Field>
  )
}
