"use client"

import {
  type NotificationPreferences,
  notificationPreferencesSchema,
  type NotificationType,
  notificationTypeSchema,
} from "@patchgrid/contracts"
import { Alert, AlertDescription } from "@patchgrid/ui/components/alert"
import { useMutation } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import { clientApi } from "@/lib/api/client"
import { failureMessage } from "@/lib/failure"
import { NOTIFICATION_TYPE_LABEL } from "@/lib/labels"

/**
 * One switch per kind of notification, each saved as it is flipped. The
 * server merges the one change into what is stored, so two tabs changing
 * different switches both keep theirs; the answer replaces local state.
 */
export function EmailPreferences({
  initial,
}: {
  initial: NotificationPreferences
}) {
  const [preferences, setPreferences] = useState(initial)
  const save = useMutation({
    mutationFn: ({ type, on }: { type: NotificationType; on: boolean }) =>
      clientApi("/notifications/preferences", {
        method: "PATCH",
        body: { email: { [type]: on } },
        schema: notificationPreferencesSchema,
      }),
    onSuccess: setPreferences,
    onError: (error) =>
      toast.error(failureMessage(error, "That choice wasn't saved. Try again.")),
  })

  return (
    <div className="grid max-w-2xl gap-4">
      {!preferences.emailEnabledForOrg && (
        <Alert>
          <AlertDescription>
            An admin has turned email notifications off for this workspace.
            Your choices are kept for when they are back on.
          </AlertDescription>
        </Alert>
      )}
      <fieldset className="grid gap-1" disabled={save.isPending}>
        <legend className="mb-2 text-sm font-semibold">Email me when</legend>
        {notificationTypeSchema.options.map((type) => (
          <label
            key={type}
            className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted"
          >
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={preferences.email[type]}
              onChange={(event) =>
                save.mutate({ type, on: event.target.checked })
              }
            />
            {NOTIFICATION_TYPE_LABEL[type]}
          </label>
        ))}
      </fieldset>
    </div>
  )
}
