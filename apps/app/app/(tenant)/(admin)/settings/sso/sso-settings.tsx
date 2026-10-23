"use client"

import {
  type SsoConnectionRequest,
  type SsoDefaultRole,
  type SsoSettings,
  ssoSettingsSchema,
} from "@patchgrid/contracts"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@patchgrid/ui/components/alert-dialog"
import { Badge } from "@patchgrid/ui/components/badge"
import { Button } from "@patchgrid/ui/components/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@patchgrid/ui/components/field"
import { Spinner } from "@patchgrid/ui/components/spinner"
import { useMutation } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import { FormAlert } from "@/components/form-alert"
import { FormField } from "@/components/form-field"
import { useStepUp } from "@/components/mfa/step-up-dialog"
import { NativeSelect } from "@/components/native-select"
import { Section } from "@/components/page-header"
import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { failureMessage } from "@/lib/failure"
import { StepUpCancelled } from "@/lib/step-up"

const ROLE_LABEL: Record<SsoDefaultRole, string> = {
  REQUESTER: "Requester — raises and follows their own tickets",
  AGENT: "Agent — works tickets, and takes a seat",
}

/**
 * The workspace's single sign-on (ADR-0054), in the order it has to be set
 * up: prove the domain, connect the provider, then — if you want — require
 * it. Saving the connection or the requirement asks you to confirm it's you:
 * whoever controls them can sign in as anyone at the domain.
 */
export function SsoSettingsForm({ initial }: { initial: SsoSettings }) {
  const [settings, setSettings] = useState(initial)
  return (
    <>
      <DomainSection settings={settings} onSaved={setSettings} />
      <DomainJoinSection settings={settings} onSaved={setSettings} />
      <ConnectionSection settings={settings} onSaved={setSettings} />
      <RequirementSection settings={settings} onSaved={setSettings} />
    </>
  )
}

type SectionProps = {
  settings: SsoSettings
  onSaved: (settings: SsoSettings) => void
}

function DomainSection({ settings, onSaved }: SectionProps) {
  const domain = settings.domain
  const [editing, setEditing] = useState(domain === null)
  const claim = useMutation({
    mutationFn: (next: string | null) =>
      clientApi("/org/domain", {
        method: "PUT",
        body: { domain: next },
        schema: ssoSettingsSchema,
      }),
    onSuccess: (updated) => {
      onSaved(updated)
      setEditing(updated.domain === null)
      toast.success(
        updated.domain === null
          ? "The domain is removed."
          : "Domain claimed. Publish the TXT record, then check it."
      )
    },
    onError: (error) =>
      toast.error(failureMessage(error, "The domain wasn't saved.")),
  })
  const verify = useMutation({
    mutationFn: () =>
      clientApi("/org/domain/verification", {
        method: "POST",
        schema: ssoSettingsSchema,
      }),
    onSuccess: (updated) => {
      onSaved(updated)
      toast.success("The domain is proved.")
    },
  })

  return (
    <Section
      title="Email domain"
      description="Sign-ins are routed by the address's domain, so the workspace has to prove it owns the domain first: publish one DNS record. Only one workspace can prove a domain."
    >
      {domain !== null && !editing ? (
        <div className="grid gap-4">
          <p className="flex items-center gap-3 text-sm">
            <span className="font-mono">{domain.name}</span>
            {domain.verifiedAt === null ? (
              <Badge variant="outline">Not proved yet</Badge>
            ) : (
              <Badge variant="secondary">
                Proved {new Date(domain.verifiedAt).toLocaleDateString()}
              </Badge>
            )}
          </p>
          {domain.record !== null && (
            <div className="grid gap-2 rounded-lg border border-border p-3 text-sm">
              <p className="text-muted-foreground">
                Add this TXT record at your DNS provider:
              </p>
              <Copyable label="Name" value={domain.record.name} />
              <Copyable label="Value" value={domain.record.value} />
            </div>
          )}
          {verify.error !== null && (
            <FormAlert>
              {failureMessage(verify.error, "DNS couldn't be checked just now.")}
            </FormAlert>
          )}
          <div className="flex flex-wrap gap-3">
            {domain.verifiedAt === null && (
              <Button onClick={() => verify.mutate()} disabled={verify.isPending}>
                {verify.isPending && <Spinner />}
                Check DNS
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => setEditing(true)}
              disabled={settings.required}
            >
              Change domain
            </Button>
            <Button
              variant="outline"
              onClick={() => claim.mutate(null)}
              disabled={settings.required || claim.isPending}
            >
              Remove
            </Button>
          </div>
          {settings.required && (
            <p className="text-xs text-muted-foreground">
              Turn off &ldquo;Require single sign-on&rdquo; to change the domain.
            </p>
          )}
        </div>
      ) : (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            claim.mutate(
              String(new FormData(event.currentTarget).get("domain") ?? "").trim()
            )
          }}
        >
          <FieldGroup>
            <FormField
              id="domain"
              name="domain"
              label="Domain"
              placeholder="acme.com"
              defaultValue={domain?.name ?? ""}
              required
              error={
                claim.error instanceof ApiError
                  ? claim.error.fieldError("domain")
                  : undefined
              }
            />
            <div className="flex gap-3">
              <Button type="submit" className="w-fit" disabled={claim.isPending}>
                {claim.isPending && <Spinner />}
                Claim domain
              </Button>
              {domain !== null && (
                <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              )}
            </div>
          </FieldGroup>
        </form>
      )}
    </Section>
  )
}

function ConnectionSection({ settings, onSaved }: SectionProps) {
  const connection = settings.connection
  const stepUp = useStepUp()
  const save = useMutation({
    mutationFn: (body: SsoConnectionRequest) =>
      stepUp.guard(() =>
        clientApi("/org/sso/connection", {
          method: "PUT",
          body,
          schema: ssoSettingsSchema,
        })
      ),
    onSuccess: (updated) => {
      onSaved(updated)
      toast.success(
        updated.connection?.enabled === true
          ? "Saved. People at your domain can sign in with SSO."
          : "Saved. Single sign-on is off."
      )
    },
    onError: (error) => {
      if (error instanceof StepUpCancelled) return
      if (error instanceof ApiError && error.status === 400) return
      toast.error(failureMessage(error, "The connection wasn't saved."))
    },
  })
  const fieldError = (path: string) =>
    save.error instanceof ApiError ? save.error.fieldError(path) : undefined

  return (
    <Section
      title="Identity provider"
      description="Any OpenID Connect provider — Okta, Entra ID, Google Workspace, Keycloak. Create a confidential web client there with this redirect URI, then paste its issuer, client ID and secret here."
    >
      <div className="grid gap-4">
        <Copyable label="Redirect URI" value={settings.redirectUri} />
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            const data = new FormData(event.currentTarget)
            const secret = String(data.get("clientSecret") ?? "")
            save.mutate({
              issuer: String(data.get("issuer") ?? "").trim(),
              clientId: String(data.get("clientId") ?? "").trim(),
              ...(secret === "" ? {} : { clientSecret: secret }),
              defaultRole: String(data.get("defaultRole")) as SsoDefaultRole,
              enabled: data.get("enabled") === "on",
            })
          }}
        >
          <fieldset disabled={save.isPending || stepUp.waiting}>
            <FieldGroup>
              <FormField
                id="issuer"
                name="issuer"
                label="Issuer URL"
                placeholder="https://login.example.com/realms/acme"
                defaultValue={connection?.issuer ?? ""}
                required
                error={fieldError("issuer")}
                description="Your organisation's own provider, not a public one. It must send email_verified, and honour max_age=0 so members can re-confirm there. With Google, only accounts your Workspace manages can sign in."
              />
              <FormField
                id="clientId"
                name="clientId"
                label="Client ID"
                defaultValue={connection?.clientId ?? ""}
                required
                error={fieldError("clientId")}
              />
              <FormField
                id="clientSecret"
                name="clientSecret"
                type="password"
                label="Client secret"
                autoComplete="off"
                placeholder={
                  connection?.clientSecretSet === true
                    ? "Saved. Leave blank to keep it"
                    : ""
                }
                error={fieldError("clientSecret")}
              />
              <Field>
                <FieldLabel htmlFor="defaultRole">
                  New people join as
                </FieldLabel>
                <NativeSelect
                  id="defaultRole"
                  name="defaultRole"
                  defaultValue={connection?.defaultRole ?? "REQUESTER"}
                >
                  {Object.entries(ROLE_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </NativeSelect>
                <FieldDescription>
                  Someone signing in for the first time gets this role. Promote
                  them afterwards under Members.
                </FieldDescription>
              </Field>
              <Field orientation="horizontal">
                <input
                  id="enabled"
                  name="enabled"
                  type="checkbox"
                  defaultChecked={connection?.enabled ?? true}
                  className="size-4 accent-primary"
                />
                <FieldLabel htmlFor="enabled" className="font-normal">
                  Let people sign in with this provider
                </FieldLabel>
              </Field>
              {save.error instanceof ApiError &&
                save.error.status === 409 && (
                  <FormAlert>{failureMessage(save.error, "")}</FormAlert>
                )}
              <Button type="submit" className="w-fit">
                {save.isPending && <Spinner />}
                Save connection
              </Button>
            </FieldGroup>
          </fieldset>
        </form>
      </div>
      {stepUp.dialog}
    </Section>
  )
}

/**
 * Letting the proved domain's people join on their own (TENANCY.md §5): off
 * by default, never above agent, and not with single sign-on required — the
 * identity provider is their way in then. A step-up action: it opens the
 * workspace to a whole domain.
 */
function DomainJoinSection({ settings, onSaved }: SectionProps) {
  const stepUp = useStepUp()
  const join = settings.domain?.join ?? { enabled: false, role: "REQUESTER" as const }
  const proved = settings.domain !== null && settings.domain.verifiedAt !== null
  const save = useMutation({
    mutationFn: (next: { enabled: boolean; role: SsoDefaultRole }) =>
      stepUp.guard(() =>
        clientApi("/org/domain/join", {
          method: "PUT",
          body: next,
          schema: ssoSettingsSchema,
        })
      ),
    onSuccess: (updated) => {
      onSaved(updated)
      toast.success(
        updated.domain?.join.enabled === true
          ? "People at the domain can now join on their own."
          : "Joining by domain is off."
      )
    },
    onError: (error) => {
      if (error instanceof StepUpCancelled) return
      toast.error(failureMessage(error, "The setting wasn't saved."))
    },
  })
  const blocked = !proved || settings.required
  return (
    <Section
      title="Join by email domain"
      description="Anyone with a verified address at the proved domain sees this workspace when they sign in to Patchgrid, and can join it themselves — no invitation and no identity provider. Nobody who was removed gets back in this way."
    >
      <div className="grid gap-3">
        <Field orientation="horizontal">
          <input
            id="domainJoin"
            type="checkbox"
            checked={join.enabled}
            disabled={(blocked && !join.enabled) || save.isPending || stepUp.waiting}
            onChange={(e) => save.mutate({ enabled: e.target.checked, role: join.role })}
            className="size-4 accent-primary"
          />
          <FieldLabel htmlFor="domainJoin" className="font-normal">
            Let people at {settings.domain?.name ?? "the domain"} join on their own
          </FieldLabel>
        </Field>
        <Field>
          <FieldLabel htmlFor="domainJoinRole">They join as</FieldLabel>
          <NativeSelect
            id="domainJoinRole"
            value={join.role}
            className="w-fit"
            disabled={save.isPending || stepUp.waiting}
            onChange={(e) =>
              save.mutate({ enabled: join.enabled, role: e.target.value === "AGENT" ? "AGENT" : "REQUESTER" })
            }
          >
            {(Object.entries(ROLE_LABEL) as [SsoDefaultRole, string][]).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {blocked && !join.enabled && (
          <p className="text-xs text-muted-foreground">
            {settings.required
              ? "With single sign-on required, people join through the identity provider."
              : "Prove the domain first."}
          </p>
        )}
      </div>
      {stepUp.dialog}
    </Section>
  )
}

function RequirementSection({ settings, onSaved }: SectionProps) {
  const stepUp = useStepUp()
  const ready =
    settings.domain !== null &&
    settings.domain.verifiedAt !== null &&
    settings.connection?.enabled === true
  // Members below owner whose addresses the provider cannot vouch for: the API says how many, and the owner decides.
  const [outside, setOutside] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: (change: { required: boolean; confirm?: boolean }) =>
      stepUp.guard(() =>
        clientApi("/org/sso/requirement", {
          method: "PUT",
          body: change,
          schema: ssoSettingsSchema,
        })
      ),
    onSuccess: (updated) => {
      setOutside(null)
      onSaved(updated)
      toast.success(
        updated.required
          ? "Single sign-on is now required of everyone but owners."
          : "Single sign-on is no longer required."
      )
    },
    onError: (error) => {
      if (error instanceof StepUpCancelled) return
      if (error instanceof ApiError && error.type === "sso-members-outside") {
        setOutside(error.message)
        return
      }
      toast.error(failureMessage(error, "The setting wasn't saved."))
    },
  })
  return (
    <Section
      title="Require single sign-on"
      description="Members who aren't owners will have to come through your identity provider the next time they open this workspace or their session renews. Nobody already in is signed out. Owners keep their own sign-in, which is how you get back in if the provider is down."
    >
      <Field orientation="horizontal">
        <input
          id="requireSso"
          type="checkbox"
          checked={settings.required}
          disabled={(!ready && !settings.required) || save.isPending || stepUp.waiting}
          onChange={(e) => save.mutate({ required: e.target.checked })}
          className="size-4 accent-primary"
        />
        <FieldLabel htmlFor="requireSso" className="font-normal">
          Require single sign-on of every member but owners
        </FieldLabel>
      </Field>
      {!ready && !settings.required && (
        <p className="mt-2 text-xs text-muted-foreground">
          Prove the domain and enable the connection first.
        </p>
      )}
      {stepUp.dialog}
      <AlertDialog open={outside !== null} onOpenChange={(open) => !open && setOutside(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Shut some members out?</AlertDialogTitle>
            <AlertDialogDescription>
              {outside} They will not be able to open this workspace until it is
              turned off again or their address changes. Owners are never shut
              out.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Leave it off</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={save.isPending}
              onClick={() => save.mutate({ required: true, confirm: true })}
            >
              {save.isPending && <Spinner />}
              Require it anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  )
}

function Copyable({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 font-mono text-xs">
          {value}
        </code>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            void navigator.clipboard
              .writeText(value)
              .then(() => toast.success(`${label} copied`))
          }}
        >
          Copy
        </Button>
      </div>
    </div>
  )
}
