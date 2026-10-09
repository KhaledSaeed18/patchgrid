import Link from "next/link"

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center px-6">
      <h1 className="font-serif text-3xl tracking-tight">Page not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        The address may be mistyped, or the page has moved.
      </p>
      <Link href="/" className="mt-6 text-sm underline underline-offset-4">
        Go to the start
      </Link>
    </main>
  )
}
