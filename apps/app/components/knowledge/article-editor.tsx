"use client"

import {
  type Article,
  articleSchema,
  type ArticleVisibility,
  articleVisibilitySchema,
  type Category,
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
import { Button } from "@patchgrid/ui/components/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@patchgrid/ui/components/field"
import { Spinner } from "@patchgrid/ui/components/spinner"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@patchgrid/ui/components/tabs"
import { Textarea } from "@patchgrid/ui/components/textarea"
import { cn } from "@patchgrid/ui/lib/utils"
import { useMutation } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { FormAlert } from "@/components/form-alert"
import { FormField } from "@/components/form-field"
import { Markdown } from "@/components/markdown"
import { NativeSelect } from "@/components/native-select"
import { useTenant } from "@/components/tenant-provider"
import { clientApi } from "@/lib/api/client"
import { ApiError } from "@/lib/api/errors"
import { categoryPath, inTreeOrder } from "@/lib/category-tree"
import { failureMessage } from "@/lib/failure"
import { newIdempotencyKey } from "@/lib/idempotency"
import { ARTICLE_VISIBILITY_HINT, ARTICLE_VISIBILITY_LABEL } from "@/lib/labels"

/**
 * Writing an article, or editing one against the version it was opened at
 * (DOMAIN.md §9.2). The body is markdown with a preview rendered exactly as
 * readers will see it. A save that lost to someone else's is a 409, said in
 * words — the editor never overwrites a colleague's change silently.
 */
export function ArticleEditor({
  article,
  categories,
}: {
  article?: Article
  categories: Category[]
}) {
  const router = useRouter()
  const { holds } = useTenant()
  const canPublish = article?.capabilities.canPublish ?? holds("kb:publish")
  // A new article is the writer's own, so it may always stay a draft.
  const canDraft = article?.capabilities.canDraft ?? true
  const [idempotencyKey] = useState(newIdempotencyKey)
  const [body, setBody] = useState(article?.body ?? "")
  const [visibility, setVisibility] = useState<ArticleVisibility>(
    article?.visibility ?? "DRAFT"
  )
  const [missing, setMissing] = useState<Record<string, string>>({})
  const options = useMemo(() => {
    const byId = new Map(categories.map((c) => [c.id, c]))
    return inTreeOrder(categories).map((c) => ({
      id: c.id,
      label: categoryPath(c, byId),
    }))
  }, [categories])

  const save = useMutation({
    mutationFn: (fields: {
      title: string
      body: string
      categoryId: string | null
      visibility: ArticleVisibility
    }) => {
      if (article === undefined) {
        const { categoryId, ...rest } = fields
        return clientApi("/articles", {
          method: "POST",
          body: { ...rest, ...(categoryId === null ? {} : { categoryId }) },
          schema: articleSchema,
          idempotencyKey,
        })
      }
      const changed = Object.fromEntries(
        Object.entries(fields).filter(
          ([k, v]) =>
            v !==
            (k === "categoryId"
              ? (article.category?.id ?? null)
              : article[k as "title" | "body" | "visibility"])
        )
      )
      return Object.keys(changed).length === 0
        ? Promise.resolve(article)
        : clientApi(`/articles/${article.id}`, {
            method: "PATCH",
            body: { version: article.version, ...changed },
            schema: articleSchema,
          })
    },
    onSuccess: (saved) => {
      router.push(`/knowledge/${saved.slug}`)
      router.refresh()
    },
  })
  const fieldError = (name: string) =>
    missing[name] ??
    (save.error instanceof ApiError ? save.error.fieldError(name) : undefined)
  const formError =
    save.error instanceof ApiError && save.error.type === "stale-write"
      ? "Someone saved this article after you opened it. Copy your changes, reload the page, and apply them to the newer version."
      : save.error !== null &&
          !(save.error instanceof ApiError && save.error.status === 400)
        ? failureMessage(save.error, "The article wasn't saved. Try again.")
        : undefined

  return (
    <form
      noValidate
      className="max-w-3xl px-6 py-8 md:px-10"
      onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        const title = String(data.get("title") ?? "").trim()
        const categoryId = String(data.get("categoryId") ?? "")
        const empty: Record<string, string> = {}
        if (title === "")
          empty.title = "Give it a title people would search for."
        if (body.trim() === "")
          empty.body = "Write the article before saving it."
        setMissing(empty)
        if (Object.keys(empty).length > 0) return
        save.mutate({
          title,
          body: body.trim(),
          categoryId: categoryId === "" ? null : categoryId,
          visibility,
        })
      }}
    >
      <FieldGroup>
        {formError !== undefined && <FormAlert>{formError}</FormAlert>}
        <FormField
          id="article-title"
          name="title"
          label="Title"
          placeholder="Connecting to the VPN from home"
          defaultValue={article?.title}
          maxLength={200}
          required
          autoFocus={article === undefined}
          error={fieldError("title")}
        />
        {options.length > 0 && (
          <Field>
            <FieldLabel htmlFor="article-category">Category</FieldLabel>
            <NativeSelect
              id="article-category"
              name="categoryId"
              defaultValue={article?.category?.id ?? ""}
            >
              <option value="">None</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
        )}
        <Field data-invalid={fieldError("body") ? true : undefined}>
          <FieldLabel htmlFor="article-body">Article</FieldLabel>
          <Tabs defaultValue="write">
            <TabsList>
              <TabsTrigger value="write">Write</TabsTrigger>
              <TabsTrigger value="preview">Preview</TabsTrigger>
            </TabsList>
            <TabsContent value="write">
              <Textarea
                id="article-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={18}
                className="font-mono text-sm"
                placeholder={
                  "## Before you start\n\n1. Open the VPN client\n2. Sign in with your work account"
                }
                aria-invalid={fieldError("body") ? true : undefined}
              />
            </TabsContent>
            <TabsContent value="preview">
              <div className="min-h-40 rounded-lg border border-input p-4">
                {body.trim() === "" ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing to preview yet.
                  </p>
                ) : (
                  <Markdown>{body}</Markdown>
                )}
              </div>
            </TabsContent>
          </Tabs>
          <FieldDescription>
            Markdown: headings, lists, tables, `code` and links.
          </FieldDescription>
          {fieldError("body") !== undefined && (
            <FieldError>{fieldError("body")}</FieldError>
          )}
        </Field>
        <FieldSet>
          <FieldLegend variant="label">Who can read it</FieldLegend>
          <div className="grid gap-2 sm:grid-cols-3">
            {articleVisibilitySchema.options.map((value) => (
              <label
                key={value}
                className={cn(
                  "flex cursor-pointer flex-col gap-0.5 rounded-lg border border-input px-3 py-2 text-sm",
                  "has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
                  "has-disabled:cursor-not-allowed has-disabled:opacity-60"
                )}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="visibility"
                    value={value}
                    checked={visibility === value}
                    disabled={
                      value !== visibility &&
                      (!canPublish || (value === "DRAFT" && !canDraft))
                    }
                    onChange={() => setVisibility(value)}
                    className="accent-primary"
                  />
                  {ARTICLE_VISIBILITY_LABEL[value]}
                </span>
                <span className="text-xs text-muted-foreground">
                  {ARTICLE_VISIBILITY_HINT[value]}
                </span>
              </label>
            ))}
          </div>
        </FieldSet>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending && <Spinner />}
            {article === undefined ? "Save article" : "Save changes"}
          </Button>
          {article?.capabilities.canDelete === true && (
            <DeleteArticle article={article} />
          )}
        </div>
      </FieldGroup>
    </form>
  )
}

function DeleteArticle({ article }: { article: Article }) {
  const [confirming, setConfirming] = useState(false)
  const router = useRouter()
  const remove = useMutation({
    mutationFn: () =>
      clientApi(`/articles/${article.id}`, { method: "DELETE", schema: null }),
    onSuccess: () => {
      router.push("/knowledge")
      router.refresh()
    },
    onError: (error) => {
      setConfirming(false)
      toast.error(failureMessage(error, "The article wasn't deleted."))
    },
  })
  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => setConfirming(true)}
      >
        Delete
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{article.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Links to it will stop working. To take it out of view without
              losing it, make it a draft instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending && <Spinner />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
