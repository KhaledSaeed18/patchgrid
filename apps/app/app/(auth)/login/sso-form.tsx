"use client"

import { ssoDiscoverResponseSchema } from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import { FieldGroup } from "@patchgrid/ui/components/field"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation } from "@tanstack/react-query"
import { useEffect } from "react"

import { FormAlert } from "@/components/form-alert"
import { FormField } from "@/components/form-field"
import { clientApi } from "@/lib/api/client"
import type { NextTarget } from "@/lib/next-url"
import { ssoStartUrl } from "@/lib/sso"

/**
 * "Sign in with SSO" (ADR-0054): the address names the workspace whose
 * identity provider vouches for it, and the browser goes there. Whether a
 * domain has single sign-on is a fact about the domain, not about the person.
 */
export function SsoForm({
  target,
  onBack,
}: {
  target: NextTarget | null
  onBack: () => void
}) {
  const discover = useMutation({
    mutationFn: async (email: string) => {
      const answer = await clientApi("/auth/sso/discover", {
        method: "POST",
        anonymous: true,
        body: { email },
        schema: ssoDiscoverResponseSchema,
      })
      return { email, sso: answer.sso }
    },
    onSuccess: ({ email, sso }) => {
      if (sso === null) return
      // Back to where the browser was going, when that is the same workspace.
      const next =
        target?.kind === "workspace" && target.slug === sso.slug
          ? pathOf(target.url)
          : undefined
      window.location.assign(
        ssoStartUrl({ email }, next === undefined ? {} : { next })
      )
    },
  })
  const none = discover.data?.sso === null
  // Back from the provider through the back/forward cache: a page frozen mid-redirect, made usable again.
  const { reset } = discover
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) reset()
    }
    window.addEventListener("pageshow", restored)
    return () => window.removeEventListener("pageshow", restored)
  }, [reset])

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        const email = String(
          new FormData(event.currentTarget).get("email") ?? ""
        ).trim()
        if (email === "") return
        discover.mutate(email)
      }}
    >
      <FieldGroup>
        <p className="text-sm text-pretty text-muted-foreground">
          Your organization signs you in. Enter your work email and we&apos;ll
          send you there.
        </p>
        {none && (
          <FormAlert tone="info">
            No workspace signs in that address through single sign-on. Use your
            email and password.
          </FormAlert>
        )}
        {discover.error !== null && (
          <FormAlert>
            Single sign-on couldn&apos;t start just now. Try again in a moment.
          </FormAlert>
        )}
        <FormField
          id="sso-email"
          name="email"
          type="email"
          label="Work email"
          autoComplete="email"
          required
          autoFocus
        />
        <Button
          type="submit"
          size="lg"
          disabled={discover.isPending || (discover.isSuccess && !none)}
        >
          {(discover.isPending || (discover.isSuccess && !none)) && <Spinner />}
          Continue
        </Button>
        <Button type="button" variant="ghost" onClick={onBack}>
          Use a password or passkey instead
        </Button>
      </FieldGroup>
    </form>
  )
}

function pathOf(url: string): string {
  const parsed = new URL(url)
  return parsed.pathname + parsed.search
}
