import Link from "next/link"

/** A workspace page that does not exist — or that this member may not see, which reads the same (RBAC.md §11). */
export default function WorkspaceNotFound() {
  return (
    <main className="px-6 py-16 md:px-10">
      <h1 className="font-serif text-2xl tracking-tight">Nothing here</h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        This page doesn&rsquo;t exist in this workspace, or your role
        doesn&rsquo;t include it. An admin can change your role if you need it.
      </p>
      <Link
        href="/"
        className="mt-6 inline-block text-sm underline underline-offset-4"
      >
        Go to your home page
      </Link>
    </main>
  )
}
