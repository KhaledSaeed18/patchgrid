"use client"

import {
  API_TOKEN_EXPIRY_DAYS,
  type ApiToken,
  type ApiTokenRole,
  apiTokenSchema,
  createdApiTokenSchema,
  type OfferedTokenScope,
  offeredTokenScopeSchema,
} from "@patchgrid/contracts"
import { Badge } from "@patchgrid/ui/components/badge"
import { Button } from "@patchgrid/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@patchgrid/ui/components/dialog"
import { Field, FieldLabel } from "@patchgrid/ui/components/field"
import { Input } from "@patchgrid/ui/components/input"
import { Spinner } from "@patchgrid/ui/components/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@patchgrid/ui/components/table"
import { useMutation } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { useStepUp } from "@/components/mfa/step-up-dialog"
import { NativeSelect } from "@/components/native-select"
import { useTenant } from "@/components/tenant-provider"
import { clientApi } from "@/lib/api/client"
import { failureMessage } from "@/lib/failure"
import { StepUpCancelled } from "@/lib/step-up"

const SCOPE_LABEL: Record<OfferedTokenScope, string> = {
  "tickets:read": "Read tickets, their files and categories",
  "tickets:write":
    "Raise, update, move and comment publicly on tickets, and upload files",
  "comments:internal": "Read and write internal notes",
  "assets:read": "Read assets",
  "assets:write": "Change assets",
  "kb:read": "Read the knowledge base",
}

const STATUS: Record<
  ApiToken["status"],
  { label: string; variant: "outline" | "destructive" }
> = {
  ACTIVE: { label: "Active", variant: "outline" },
  EXPIRED: { label: "Expired", variant: "destructive" },
  REVOKED: { label: "Revoked", variant: "destructive" },
}

const when = (iso: string | null, never: string) =>
  iso === null ? never : new Date(iso).toLocaleDateString()

/**
 * The workspace's API tokens (ADR-0021, ADR-0042): who made each, what it
 * may do, when it was last used and when it lapses. A new token's secret is
 * shown once, in the dialog that creates it, and never again.
 */
export function ApiTokens({ initial }: { initial: ApiToken[] }) {
  const { holds } = useTenant()
  const router = useRouter()
  const [creating, setCreating] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<ApiToken | null>(null)
  const revoke = useMutation({
    mutationFn: (id: string) =>
      clientApi(`/org/api-tokens/${id}/revoke`, {
        method: "POST",
        schema: apiTokenSchema,
      }),
    onSuccess: (token) => {
      setRevoking(null)
      toast.success(`${token.name} is revoked. Its next request is refused.`)
      router.refresh()
    },
    onError: (error) =>
      toast.error(failureMessage(error, "The token wasn't revoked.")),
  })

  return (
    <div className="px-6 py-6 md:px-10">
      {holds("token:create") && (
        <Button onClick={() => setCreating(true)}>Create token</Button>
      )}
      {initial.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          No tokens yet. Anything that reaches this workspace without a person
          behind it uses one.
        </p>
      ) : (
        <Table className="mt-6">
          <TableHeader>
            <TableRow>
              <TableHead>Token</TableHead>
              <TableHead>Can</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-0">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {initial.map((token) => (
              <TableRow
                key={token.id}
                className={token.status === "ACTIVE" ? undefined : "opacity-60"}
              >
                <TableCell>
                  <p className="font-medium">{token.name}</p>
                  <p className="font-mono text-xs text-muted-foreground">
                    pg_{token.prefix}_…
                  </p>
                  <p className="text-xs text-muted-foreground">
                    by {token.createdBy.displayName},{" "}
                    {when(token.createdAt, "")}
                  </p>
                </TableCell>
                <TableCell className="text-xs">
                  <p>
                    As {token.role === "AGENT" ? "an agent" : "a requester"}
                  </p>
                  <p className="text-muted-foreground">
                    {token.scopes.join(", ")}
                  </p>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {when(token.lastUsedAt, "Never")}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {when(token.expiresAt, "Never")}
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS[token.status].variant}>
                    {STATUS[token.status].label}
                  </Badge>
                </TableCell>
                <TableCell>
                  {token.status !== "REVOKED" && holds("token:revoke") && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRevoking(token)}
                    >
                      Revoke
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <CreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(value) => {
          setCreating(false)
          setSecret(value)
          router.refresh()
        }}
      />
      <SecretDialog secret={secret} onClose={() => setSecret(null)} />
      <Dialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke {revoking?.name}?</DialogTitle>
            <DialogDescription>
              Whatever uses it is refused from its next request, and its service
              account is paused. Its tickets and history stay under its name.
              This cannot be undone; create a new token instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevoking(null)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={revoke.isPending || revoking === null}
              onClick={() => revoking !== null && revoke.mutate(revoking.id)}
            >
              {revoke.isPending && <Spinner />}
              Revoke token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function CreateDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (secret: string) => void
}) {
  const [name, setName] = useState("")
  const [role, setRole] = useState<ApiTokenRole>("AGENT")
  const [scopes, setScopes] = useState<OfferedTokenScope[]>(["tickets:read"])
  const [days, setDays] = useState<string>("90")
  // A token outlives the session that made it: the API asks for a fresh proof first (ADR-0029).
  const stepUp = useStepUp()
  const create = useMutation({
    mutationFn: () =>
      stepUp.guard(() =>
        clientApi("/org/api-tokens", {
          method: "POST",
          body: {
            name: name.trim(),
            role,
            scopes,
            expiresInDays: days === "never" ? null : Number(days),
          },
          schema: createdApiTokenSchema,
        })
      ),
    onSuccess: (created) => {
      setName("")
      setScopes(["tickets:read"])
      onCreated(created.secret)
    },
    onError: (error) => {
      if (error instanceof StepUpCancelled) return
      toast.error(failureMessage(error, "The token wasn't created."))
    },
  })
  const toggle = (scope: OfferedTokenScope) =>
    setScopes((current) =>
      current.includes(scope)
        ? current.filter((s) => s !== scope)
        : [...current, scope]
    )

  return (
    <>
      {stepUp.dialog}
      <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create an API token</DialogTitle>
            <DialogDescription>
              It appears in the member list as a service account named after it.
              Give it only what its job needs; its scopes cannot be changed
              later.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <Field>
              <FieldLabel htmlFor="token-name">Name</FieldLabel>
              <Input
                id="token-name"
                value={name}
                maxLength={80}
                placeholder="Zabbix alerts"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="token-role">Acts as</FieldLabel>
              <NativeSelect
                id="token-role"
                value={role}
                onChange={(e) => setRole(e.target.value as ApiTokenRole)}
              >
                <option value="AGENT">
                  An agent: sees and works every ticket
                </option>
                <option value="REQUESTER">
                  A requester: raises tickets and sees its own
                </option>
              </NativeSelect>
            </Field>
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">Scopes</legend>
              {offeredTokenScopeSchema.options.map((scope) => (
                <label key={scope} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 accent-primary"
                    checked={scopes.includes(scope)}
                    onChange={() => toggle(scope)}
                  />
                  <span>
                    {SCOPE_LABEL[scope]}{" "}
                    <span className="font-mono text-xs text-muted-foreground">
                      {scope}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            <Field>
              <FieldLabel htmlFor="token-expiry">Expires</FieldLabel>
              <NativeSelect
                id="token-expiry"
                value={days}
                onChange={(e) => setDays(e.target.value)}
              >
                {API_TOKEN_EXPIRY_DAYS.map((d) => (
                  <option key={d} value={String(d)}>
                    In {d} days
                  </option>
                ))}
                <option value="never">Never — until revoked</option>
              </NativeSelect>
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={
                create.isPending || name.trim() === "" || scopes.length === 0
              }
              onClick={() => create.mutate()}
            >
              {create.isPending && <Spinner />}
              Create token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function SecretDialog({
  secret,
  onClose,
}: {
  secret: string | null
  onClose: () => void
}) {
  return (
    <Dialog open={secret !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy your token now</DialogTitle>
          <DialogDescription>
            This is the only time it is shown. Patchgrid keeps only a hash of
            it; if it is lost, revoke it and create another.
          </DialogDescription>
        </DialogHeader>
        <code
          aria-label="API token"
          className="block rounded-md border border-border bg-muted p-3 font-mono text-xs break-all select-all"
        >
          {secret}
        </code>
        <p className="text-xs text-muted-foreground">
          Send it as <span className="font-mono">Authorization: Bearer …</span>{" "}
          to the API.
        </p>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() =>
              secret !== null &&
              void navigator.clipboard
                .writeText(secret)
                .then(() => toast.success("Copied."))
            }
          >
            Copy
          </Button>
          <Button onClick={onClose}>I&apos;ve stored it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
