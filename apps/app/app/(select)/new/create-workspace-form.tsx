"use client"

import {
  createOrganizationResponseSchema,
  SLUG_MAX_LENGTH,
  type SlugAvailability,
  slugAvailabilitySchema,
} from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import { FieldGroup } from "@patchgrid/ui/components/field"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"

import { FormAlert } from "@/components/form-alert"
import { FormField } from "@/components/form-field"
import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { ROOT_DOMAIN, workspaceOrigin } from "@/lib/config"
import { suggestSlug } from "@/lib/suggest-slug"

const REASON: Record<NonNullable<SlugAvailability["reason"]>, string> = {
  "too-short": "Use at least 3 characters.",
  "too-long": `Use at most ${SLUG_MAX_LENGTH} characters.`,
  "invalid-characters":
    "Use lowercase letters, numbers and single hyphens, starting and ending with a letter or number.",
  reserved: "That address is reserved. Try another.",
  taken: "That address is taken. Try another.",
}

export function CreateWorkspaceForm() {
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [slugEdited, setSlugEdited] = useState(false)
  const debounced = useDebounced(slug, 300)

  const availability = useQuery({
    queryKey: ["slug-available", debounced],
    queryFn: () =>
      clientApi(`/orgs/slug-available?slug=${encodeURIComponent(debounced)}`, {
        schema: slugAvailabilitySchema,
      }),
    enabled: debounced !== "",
    staleTime: 10_000,
  })

  const create = useMutation({
    mutationFn: (form: { name: string; slug: string; domain?: string }) =>
      clientApi("/orgs", {
        method: "POST",
        body: form,
        schema: createOrganizationResponseSchema,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: (response) =>
      window.location.assign(workspaceOrigin(response.session.slug)),
  })

  const settled =
    availability.data?.slug === slug ? availability.data : undefined
  const slugError =
    (create.error instanceof ApiError
      ? create.error.fieldError("slug")
      : undefined) ??
    (settled !== undefined && !settled.available && settled.reason !== null
      ? REASON[settled.reason]
      : undefined) ??
    (create.error instanceof ApiError && create.error.status === 409
      ? REASON.taken
      : undefined)

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        const domain = String(
          new FormData(event.currentTarget).get("domain") ?? ""
        ).trim()
        create.mutate({
          name: name.trim(),
          slug,
          ...(domain === "" ? {} : { domain }),
        })
      }}
    >
      <FieldGroup>
        {create.error !== null && slugError === undefined && (
          <FormAlert>
            {create.error instanceof ApiError && create.error.status === 401
              ? "Confirm your email address first: open the link we sent when you signed up."
              : "The workspace wasn't created. Check the fields and try again."}
          </FormAlert>
        )}
        <FormField
          id="name"
          label="Workspace name"
          placeholder="Acme IT"
          required
          autoFocus
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            if (!slugEdited) setSlug(suggestSlug(event.target.value))
          }}
          error={
            create.error instanceof ApiError
              ? create.error.fieldError("name")
              : undefined
          }
        />
        <FormField
          id="slug"
          label="Address"
          required
          value={slug}
          spellCheck={false}
          autoCapitalize="none"
          onChange={(event) => {
            setSlugEdited(true)
            setSlug(event.target.value.toLowerCase())
          }}
          description={
            <span className="font-mono">
              {slug === "" ? "your-team" : slug}.{ROOT_DOMAIN}
              {settled?.available === true && (
                <span className="ml-2 font-sans text-foreground">is free</span>
              )}
            </span>
          }
          error={slugError}
        />
        <FormField
          id="domain"
          name="domain"
          label="Company email domain (optional)"
          placeholder="acme.com"
          spellCheck={false}
          autoCapitalize="none"
          description="Used later to let colleagues at this domain join. Proving you own it is a separate step."
          error={
            create.error instanceof ApiError
              ? create.error.fieldError("domain")
              : undefined
          }
        />
        <Button
          type="submit"
          size="lg"
          disabled={
            create.isPending ||
            create.isSuccess ||
            name.trim() === "" ||
            settled?.available === false
          }
        >
          {(create.isPending || create.isSuccess) && <Spinner />}
          Create workspace
        </Button>
      </FieldGroup>
    </form>
  )
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}
