"use client"

import {
  PASSWORD_MIN_LENGTH,
  type ProblemDetails,
  problemDetailsSchema,
  REQUESTED_WITH,
  type SlugAvailability,
  slugAvailabilitySchema,
  suggestSlug,
} from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@patchgrid/ui/components/field"
import { Input } from "@patchgrid/ui/components/input"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useEffect, useState } from "react"

import { API_URL, PENDING_WORKSPACE_COOKIE, ROOT_DOMAIN } from "@/lib/config"

const REASON: Record<NonNullable<SlugAvailability["reason"]>, string> = {
  "too-short": "Use at least 3 characters.",
  "too-long": "Use at most 30 characters.",
  "invalid-characters": "Use lowercase letters, numbers and single hyphens.",
  reserved: "That address is reserved. Try another.",
  taken: "That address is taken. Try another.",
}

/**
 * Signup answers the same whether or not the address already has an account
 * (ADR-0031), so this form's success state is the same either way: check
 * your inbox. The chosen workspace rides along in a cookie the app reads once
 * the email is confirmed; it is not reserved until then.
 */
export function SignupForm() {
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [slugEdited, setSlugEdited] = useState(false)
  const availability = useSlugCheck(slug)
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "sent"; email: string }
    | { kind: "failed"; problem: ProblemDetails | null }
  >({ kind: "idle" })

  if (state.kind === "sent") {
    return (
      <div
        role="status"
        className="rounded-lg border border-border bg-card p-5 text-sm leading-relaxed"
      >
        <p className="font-semibold">Check {state.email}</p>
        <p className="mt-2 text-muted-foreground">
          We sent a link to confirm the address. It works for 24 hours;
          following it signs you in and takes you straight to creating{" "}
          <span className="font-mono text-foreground">
            {slug}.{ROOT_DOMAIN}
          </span>
          .
        </p>
      </div>
    )
  }

  const fieldError = (path: string) =>
    state.kind === "failed"
      ? state.problem?.errors?.find((e) => e.path === path)?.message
      : undefined
  const slugError =
    availability !== null &&
    availability.slug === slug &&
    !availability.available &&
    availability.reason !== null
      ? REASON[availability.reason]
      : undefined

  return (
    <form
      noValidate
      onSubmit={async (event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        const email = String(data.get("email")).trim()
        setState({ kind: "sending" })
        const response = await fetch(`${API_URL}/auth/signup`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": REQUESTED_WITH,
          },
          credentials: "include",
          body: JSON.stringify({
            name: String(data.get("fullName")).trim(),
            email,
            password: String(data.get("password")),
          }),
        }).catch(() => null)
        if (response?.status === 202) {
          const pending = encodeURIComponent(
            JSON.stringify({ name: name.trim(), slug })
          )
          document.cookie = `${PENDING_WORKSPACE_COOKIE}=${pending}; Domain=.${ROOT_DOMAIN}; Path=/; Max-Age=86400; SameSite=Lax`
          setState({ kind: "sent", email })
          return
        }
        const body: unknown = await response?.json().catch(() => null)
        const parsed = problemDetailsSchema.safeParse(body)
        setState({
          kind: "failed",
          problem: parsed.success ? parsed.data : null,
        })
      }}
    >
      <FieldGroup>
        {state.kind === "failed" && state.problem?.errors === undefined && (
          <p role="alert" className="text-sm text-destructive">
            {state.problem?.status === 429
              ? "Too many attempts from here. Wait a minute, then try again."
              : "Signing up didn't work just now. Try again in a moment."}
          </p>
        )}
        <TextField
          id="fullName"
          label="Your name"
          autoComplete="name"
          required
          error={fieldError("name")}
        />
        <TextField
          id="email"
          label="Work email"
          type="email"
          autoComplete="email"
          required
          error={fieldError("email")}
        />
        <TextField
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          required
          description={`At least ${PASSWORD_MIN_LENGTH} characters. A short sentence works well.`}
          error={fieldError("password")}
        />
        <TextField
          id="workspace"
          label="Workspace name"
          placeholder="Acme IT"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            if (!slugEdited) setSlug(suggestSlug(e.target.value))
          }}
        />
        <TextField
          id="slug"
          label="Address"
          value={slug}
          spellCheck={false}
          autoCapitalize="none"
          onChange={(e) => {
            setSlugEdited(true)
            setSlug(e.target.value.toLowerCase())
          }}
          description={
            <span className="font-mono">
              {slug === "" ? "your-team" : slug}.{ROOT_DOMAIN}
              {availability?.slug === slug && availability.available && (
                <span className="ml-2 font-sans text-foreground">is free</span>
              )}
            </span>
          }
          error={slugError}
        />
        <Button
          type="submit"
          size="lg"
          disabled={state.kind === "sending" || slugError !== undefined}
        >
          {state.kind === "sending" && <Spinner />}
          Create account
        </Button>
        <p className="text-xs text-muted-foreground">
          The address isn&rsquo;t held until you confirm your email; if someone
          takes it first, you&rsquo;ll pick another.
        </p>
      </FieldGroup>
    </form>
  )
}

function TextField({
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
        name={id}
        aria-invalid={error !== undefined ? true : undefined}
        {...input}
      />
      {description !== undefined && error === undefined && (
        <FieldDescription>{description}</FieldDescription>
      )}
      {error !== undefined && <FieldError>{error}</FieldError>}
    </Field>
  )
}

/** The live check (ADR-0016's second endpoint), debounced so typing is not a request per key. */
function useSlugCheck(slug: string): SlugAvailability | null {
  const [result, setResult] = useState<SlugAvailability | null>(null)
  useEffect(() => {
    if (slug === "") return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetch(`${API_URL}/orgs/slug-available?slug=${encodeURIComponent(slug)}`, {
        signal: controller.signal,
      })
        .then((r) => r.json())
        .then((body: unknown) => {
          const parsed = slugAvailabilitySchema.safeParse(body)
          if (parsed.success) setResult(parsed.data)
        })
        .catch(() => undefined)
    }, 300)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [slug])
  return result
}
