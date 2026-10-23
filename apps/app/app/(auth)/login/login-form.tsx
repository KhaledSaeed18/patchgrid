"use client"

import {
  type FactorMethod,
  loginResponseSchema,
  signedInResponseSchema,
  type SignedInResponse,
  type SsoErrorCode,
} from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import { FieldGroup } from "@patchgrid/ui/components/field"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation } from "@tanstack/react-query"
import Link from "next/link"
import { useState } from "react"

import { FormField } from "@/components/form-field"
import { FormAlert } from "@/components/form-alert"
import { FactorForm, type FactorProof } from "@/components/mfa/factor-form"
import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { parseNext } from "@/lib/next-url"
import { SSO_ERROR_MESSAGE, ssoStartUrl } from "@/lib/sso"
import {
  assertWithPasskey,
  PasskeyCancelled,
  usePasskeysAvailable,
} from "@/lib/passkeys"

import { SsoForm } from "./sso-form"

/**
 * A passkey alone, or email and password — then, for an account with a
 * second factor, the factor (ADR-0045, ADR-0053). When the browser arrived
 * from a workspace, the login asks for that workspace's session in the same
 * request and goes straight back; otherwise it goes to the picker. One
 * message for every failure: the API does not say whether the address
 * exists, and neither does this page.
 */
export function LoginForm({
  next,
  ssoError,
}: {
  next: string | undefined
  ssoError: SsoErrorCode | null
}) {
  const target = parseNext(next)
  const slug = target?.kind === "workspace" ? { slug: target.slug } : {}
  const [stage, setStage] = useState<
    | { kind: "password" }
    | { kind: "factor"; methods: FactorMethod[] }
    | { kind: "sso" }
  >(ssoError === null ? { kind: "password" } : { kind: "sso" })
  const canPasskey = usePasskeysAvailable()
  const go = (response: SignedInResponse) => {
    if (target?.kind === "workspace" && response.session !== null) {
      window.location.assign(target.url)
    } else if (target?.kind === "workspace") {
      // Signed in, but the workspace withheld its session: ask it why, and go where that leads.
      void openOrExplain(target.slug, target.url)
    } else if (target?.kind === "path") {
      window.location.assign(target.path)
    } else {
      window.location.assign("/workspaces")
    }
  }

  const login = useMutation({
    mutationFn: (form: { email: string; password: string }) =>
      clientApi("/auth/login", {
        method: "POST",
        anonymous: true,
        body: { ...form, ...slug },
        schema: loginResponseSchema,
      }),
    onSuccess: (response) => {
      if (response.status === "mfa-required")
        setStage({ kind: "factor", methods: response.methods })
      else go(response)
    },
  })
  // Nothing typed: the passkey is both factors (ADR-0053).
  const passkey = useMutation({
    mutationFn: async () => {
      const proof = await assertWithPasskey("/auth/passkeys/login/options", true)
      return clientApi("/auth/passkeys/login", {
        method: "POST",
        anonymous: true,
        body: { ...proof, ...slug },
        schema: signedInResponseSchema,
      })
    },
    onSuccess: go,
  })
  const factor = useMutation({
    mutationFn: (proof: FactorProof) =>
      clientApi("/auth/mfa", {
        method: "POST",
        anonymous: true,
        body: proof,
        schema: loginResponseSchema,
      }),
    onSuccess: (response) => {
      if (response.status === "signed-in") go(response)
    },
  })

  if (stage.kind === "factor") {
    return (
      <FactorForm
        methods={stage.methods}
        passkeyOptions="/auth/mfa/passkey/options"
        anonymous
        onSubmit={(proof) => factor.mutate(proof)}
        pending={factor.isPending || factor.isSuccess}
        error={factor.error}
        submitLabel="Sign in"
      >
        <p className="text-sm text-pretty text-muted-foreground">
          Your account has two-factor authentication on.{" "}
          {stage.methods.includes("totp")
            ? "Enter the code from your authenticator app."
            : "Confirm with your passkey."}
        </p>
      </FactorForm>
    )
  }

  if (stage.kind === "sso") {
    return (
      <div className="grid gap-4">
        {ssoError !== null && <FormAlert>{SSO_ERROR_MESSAGE[ssoError]}</FormAlert>}
        <SsoForm target={target} onBack={() => setStage({ kind: "password" })} />
      </div>
    )
  }

  const passkeyFailed =
    passkey.error !== null && !(passkey.error instanceof PasskeyCancelled)

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        login.mutate({
          email: String(data.get("email")),
          password: String(data.get("password")),
        })
      }}
    >
      <FieldGroup>
        {login.error !== null && (
          <FormAlert>{messageFor(login.error)}</FormAlert>
        )}
        {passkeyFailed && (
          <FormAlert>
            That passkey didn&apos;t sign you in. Try again, or use your email
            and password.
          </FormAlert>
        )}
        <FormField
          id="email"
          name="email"
          type="email"
          label="Email"
          autoComplete="email"
          required
          autoFocus
        />
        <FormField
          id="password"
          name="password"
          type="password"
          label="Password"
          autoComplete="current-password"
          required
          description={
            <Link
              href="/reset-password"
              className="underline underline-offset-4"
            >
              Forgot your password?
            </Link>
          }
        />
        <Button
          type="submit"
          size="lg"
          disabled={login.isPending || login.isSuccess}
        >
          {(login.isPending || login.isSuccess) && <Spinner />}
          Sign in
        </Button>
        {canPasskey && (
          <Button
            type="button"
            size="lg"
            variant="outline"
            disabled={passkey.isPending || passkey.isSuccess}
            onClick={() => passkey.mutate()}
          >
            {(passkey.isPending || passkey.isSuccess) && <Spinner />}
            Sign in with a passkey
          </Button>
        )}
        <Button
          type="button"
          size="lg"
          variant="ghost"
          onClick={() => setStage({ kind: "sso" })}
        >
          Sign in with SSO
        </Button>
      </FieldGroup>
    </form>
  )
}

/**
 * The login named a workspace that did not open: it requires single sign-on
 * (to the provider, coming back to the page that was wanted — ADR-0054) or
 * a second factor (to set one up), or the person is not a member (the picker).
 */
async function openOrExplain(slug: string, url: string): Promise<void> {
  try {
    await clientApi("/auth/sessions", { method: "POST", body: { slug }, schema: null })
    window.location.assign(url)
  } catch (error) {
    if (error instanceof ApiError && error.type === "sso-required") {
      const wanted = new URL(url)
      window.location.assign(ssoStartUrl({ slug }, { next: wanted.pathname + wanted.search }))
    } else if (error instanceof ApiError && error.type === "mfa-required") {
      window.location.assign(`/account/security?required=${encodeURIComponent(slug)}`)
    } else {
      window.location.assign("/workspaces")
    }
  }
}

function messageFor(error: Error): string {
  if (error instanceof ApiError && error.status === 401) {
    return "That email and password don't match an account. Check both, or reset your password."
  }
  if (error instanceof ApiError && error.type === "rate-limited") {
    return "Too many attempts from here. Wait a minute, then try again."
  }
  return "Signing in didn't work just now. Try again in a moment."
}
