"use client"

import {
  type AgentVisibility,
  changeSlugResponseSchema,
  type OrganizationSettings,
  organizationSettingsSchema,
  type Usage,
} from "@patchgrid/contracts"
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
import { NativeSelect } from "@/components/native-select"
import { Section } from "@/components/page-header"
import { useTenant } from "@/components/tenant-provider"
import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { ROOT_DOMAIN, workspaceOrigin } from "@/lib/config"

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
          "name" | "agentVisibility" | "emailNotificationsEnabled"
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
    </>
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
