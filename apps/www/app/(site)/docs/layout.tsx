import { DocsNav } from "@/components/docs-nav"

export default function DocsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-6 pt-8 pb-24 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-16">
      <DocsNav />
      {children}
    </div>
  )
}
