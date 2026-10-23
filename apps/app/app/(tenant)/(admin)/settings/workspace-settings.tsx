"use client"

import {
  type AgentVisibility,
  changeSlugResponseSchema,
  ORG_DELETION_WINDOW_DAYS,
  type OrganizationSettings,
  organizationSettingsSchema,
  type Usage,
} from "@patchgrid/contracts"
import { Button } from "@patchgrid/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@patchgrid/ui/components/dialog"
import { Input } from "@patchgrid/ui/components/input"
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
import { useTenant } from "@/components/tenant-provider"
import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { appOrigin, ROOT_DOMAIN, workspaceOrigin } from "@/lib/config"
import { failureMessage } from "@/lib/failure"
import { StepUpCancelled } from "@/lib/step-up"

import { WorkspaceExport } from "./workspace-export"

const VISIBILITY: Record<AgentVisibility, string> = {
  ALL_TICKETS: "Every ticket in the workspace",
  OWN_TEAM_ONLY: "Their teams' tickets, unassigned ones, and their own",
}

const METRIC: Record<Usage["metrics"][number]["metric"], string> = {
  AGENT_SEATS: "Agent seats",
  TICKETS_CREATED: "Tickets this month",
  STORAGE_BYTES: "Attachment storage",
  AUTOMATION_RULES: "Automation rules",
  KB_ARTICLES: "Knowledge articles",
  API_TOKENS: "API tokens",
}

export function WorkspaceSettings({
  initial,
  usage,
}: {
  initial: OrganizationSettings
  usage: Usage
}) {
  const { holds } = useTenant()
  const [settings, setSettings] = useState(initial)
  const canEdit = holds("org:update_settings")

  const save = useMutation({
    mutationFn: (
      change: Partial<
        Pick<
          OrganizationSettings,
          | "name"
          | "agentVisibility"
          | "emailNotificationsEnabled"
          | "allowExternalRequesters"
        >
      >
    ) =>
      clientApi("/org/settings", {
        method: "PATCH",
        body: change,
        schema: organizationSettingsSchema,
      }),
    onSuccess: (updated) => {
      setSettings(updated)
      toast.success("Settings saved")
    },
    onError: () => toast.error("The settings weren't saved. Try again."),
  })

  return (
    <>
      <Section
        title="General"
        description="The name everyone in this workspace sees, in the picker and on email."
      >
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            const data = new FormData(event.currentTarget)
            save.mutate({
              name: String(data.get("name")).trim(),
              agentVisibility: String(
                data.get("agentVisibility")
              ) as AgentVisibility,
              emailNotificationsEnabled: data.get("email") === "on",
              allowExternalRequesters: data.get("external") === "on",
            })
          }}
        >
          <fieldset disabled={!canEdit || save.isPending}>
            <FieldGroup>
              <FormField
                id="name"
                name="name"
                label="Workspace name"
                defaultValue={settings.name}
                required
                error={
                  save.error instanceof ApiError
                    ? save.error.fieldError("name")
                    : undefined
                }
              />
              <Field>
                <FieldLabel htmlFor="agentVisibility">
                  What agents can see
                </FieldLabel>
                <NativeSelect
                  id="agentVisibility"
                  name="agentVisibility"
                  defaultValue={settings.agentVisibility}
                >
                  {Object.entries(VISIBILITY).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </NativeSelect>
                <FieldDescription>
                  Admins and owners always see everything.
                </FieldDescription>
              </Field>
              <Field orientation="horizontal">
                <input
                  id="email"
                  name="email"
                  type="checkbox"
                  defaultChecked={settings.emailNotificationsEnabled}
                  className="size-4 accent-primary"
                />
                <FieldLabel htmlFor="email" className="font-normal">
                  Send email notifications to members
                </FieldLabel>
              </Field>
              <Field>
                <div className="flex items-center gap-3">
                  <input
                    id="external"
                    name="external"
                    type="checkbox"
                    defaultChecked={settings.allowExternalRequesters}
                    className="size-4 accent-primary"
                  />
                  <FieldLabel htmlFor="external" className="font-normal">
                    Take mail from people outside the workspace
                  </FieldLabel>
                </div>
                <FieldDescription>
                  Mail to{" "}
                  <span className="font-mono">{settings.inboundAddress}</span>{" "}
                  from an address that is no member&apos;s opens a ticket for
                  them, marked External. They hear back by email and never sign
                  in. Pause one under Members to stop their mail.
                </FieldDescription>
              </Field>
              {canEdit && (
                <Button type="submit" className="w-fit">
                  {save.isPending && <Spinner />}
                  Save changes
                </Button>
              )}
            </FieldGroup>
          </fieldset>
        </form>
      </Section>

      <Section
        title="Address"
        description="Changing it moves everyone to the new address. The old one forwards for 30 days and is never given to anyone else."
      >
        {holds("org:change_slug") ? (
          <ChangeSlug settings={settings} />
        ) : (
          <p className="font-mono text-sm">
            {settings.slug}.{ROOT_DOMAIN}
          </p>
        )}
      </Section>

      <Section
        title="Email"
        description="Mail to this address becomes a ticket, and replies to ticket emails land on their ticket. Only members' mail that passes DMARC is taken; the rest is listed in the inbound log."
      >
        <p className="font-mono text-sm break-all">{settings.inboundAddress}</p>
      </Section>

      <Section
        title="Plan and usage"
        description={`This workspace is on the ${usage.plan === "FREE" ? "Free" : "Pro"} plan.`}
      >
        <dl className="grid gap-3">
          {usage.metrics.map((m) => (
            <div
              key={m.metric}
              className="flex items-baseline justify-between gap-4 border-b border-border pb-2 text-sm"
            >
              <dt className="text-muted-foreground">{METRIC[m.metric]}</dt>
              <dd className="tabular-nums">
                {format(m.metric, m.used)}{" "}
                <span className="text-muted-foreground">
                  of{" "}
                  {m.limit === null ? "unlimited" : format(m.metric, m.limit)}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      {holds("org:require_mfa") && (
        <RequireMfa settings={settings} onSaved={setSettings} />
      )}

      {holds("org:export") && <WorkspaceExport />}

      {holds("org:delete") && <DeleteWorkspace settings={settings} />}
    </>
  )
}

/**
 * The owner's policy (ADR-0029, ADR-0045): every member must hold a second
 * factor to open the workspace. It gates the next sign-in, not the sessions
 * already open — a policy, not an outage.
 */
function RequireMfa({
  settings,
  onSaved,
}: {
  settings: OrganizationSettings
  onSaved: (updated: OrganizationSettings) => void
}) {
  const save = useMutation({
    mutationFn: (requireMfa: boolean) =>
      clientApi("/org/settings", {
        method: "PATCH",
        body: { requireMfa },
        schema: organizationSettingsSchema,
      }),
    onSuccess: (updated) => {
      onSaved(updated)
      toast.success(
        updated.requireMfa
          ? "Two-factor authentication is now required."
          : "Two-factor authentication is no longer required."
      )
    },
    onError: (error) =>
      toast.error(failureMessage(error, "The setting wasn't saved.")),
  })
  return (
    <Section
      title="Security"
      description="Members without an authenticator app set up will be asked to add one the next time they open this workspace. Nobody who is already in is signed out."
    >
      <Field orientation="horizontal">
        <input
          id="requireMfa"
          type="checkbox"
          checked={settings.requireMfa}
          disabled={save.isPending}
          onChange={(e) => save.mutate(e.target.checked)}
          className="size-4 accent-primary"
        />
        <FieldLabel htmlFor="requireMfa" className="font-normal">
          Require two-factor authentication of every member
        </FieldLabel>
      </Field>
    </Section>
  )
}

/**
 * The owner's way out (ADR-0043): typed, not clicked. Everyone is signed out
 * at once; the purge waits the window, and any owner can take it back from
 * the workspace list until then.
 */
function DeleteWorkspace({ settings }: { settings: OrganizationSettings }) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState("")
  const stepUp = useStepUp()
  const remove = useMutation({
    mutationFn: () =>
      stepUp.guard(() =>
        clientApi("/org/deletion", {
          method: "POST",
          body: { confirmSlug: typed },
          schema: null,
        })
      ),
    onSuccess: () => window.location.assign(`${appOrigin()}/workspaces`),
    onError: (error) => {
      if (error instanceof StepUpCancelled) return
      toast.error(failureMessage(error, "The workspace wasn't deleted."))
    },
  })
  return (
    <Section
      title="Delete workspace"
      description={`Signs everyone out and closes ${settings.slug}.${ROOT_DOMAIN} at once. After ${String(ORG_DELETION_WINDOW_DAYS)} days every ticket, file, asset, article and audit entry is erased for good. Until then any owner can cancel it from the workspace list.`}
    >
      <Button
        variant="destructive"
        className="w-fit"
        onClick={() => setOpen(true)}
      >
        Delete workspace
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {settings.name}?</DialogTitle>
            <DialogDescription>
              Type <span className="font-mono">{settings.slug}</span> to
              confirm. Everyone, you included, is signed out now.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Type the address to confirm"
            value={typed}
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
            placeholder={settings.slug}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={typed !== settings.slug || remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending && <Spinner />}
              Delete workspace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {stepUp.dialog}
    </Section>
  )
}

function ChangeSlug({ settings }: { settings: OrganizationSettings }) {
  const [slug, setSlug] = useState(settings.slug)
  const change = useMutation({
    mutationFn: () =>
      clientApi("/org/slug", {
        method: "POST",
        body: { slug },
        schema: changeSlugResponseSchema,
      }),
    // The response set this browser's cookies for the new address; go there.
    onSuccess: (result) =>
      window.location.assign(`${workspaceOrigin(result.slug)}/settings`),
  })
  const waiting = settings.slugChangeAvailableAt
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        change.mutate()
      }}
    >
      <FieldGroup>
        {change.error !== null &&
          change.error instanceof ApiError &&
          change.error.fieldError("slug") === undefined && (
            <FormAlert>{change.error.message}</FormAlert>
          )}
        <FormField
          id="slug"
          label="Workspace address"
          value={slug}
          spellCheck={false}
          onChange={(event) => setSlug(event.target.value.toLowerCase())}
          disabled={waiting !== null}
          description={
            waiting !== null ? (
              `The address can change again on ${new Date(waiting).toLocaleDateString()}.`
            ) : (
              <span className="font-mono">
                {slug}.{ROOT_DOMAIN}
              </span>
            )
          }
          error={
            change.error instanceof ApiError
              ? change.error.fieldError("slug")
              : undefined
          }
        />
        <Button
          type="submit"
          variant="outline"
          className="w-fit"
          disabled={
            waiting !== null || slug === settings.slug || change.isPending
          }
        >
          {change.isPending && <Spinner />}
          Change address
        </Button>
      </FieldGroup>
    </form>
  )
}

function format(
  metric: Usage["metrics"][number]["metric"],
  value: number
): string {
  if (metric !== "STORAGE_BYTES") return value.toLocaleString()
  const gb = value / 1024 ** 3
  return gb >= 1
    ? `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`
    : `${Math.round(value / 1024 ** 2)} MB`
}
