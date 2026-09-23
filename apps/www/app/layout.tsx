import type { Metadata } from "next"

import "@patchgrid/ui/globals.css"
import { fontVariables } from "@patchgrid/ui/lib/fonts"
import { cn } from "@patchgrid/ui/lib/utils"

export const metadata: Metadata = {
  title: {
    default: "Patchgrid — IT service management",
    template: "%s · Patchgrid",
  },
  description:
    "A multi-tenant ITSM platform: incidents, service requests, problems and changes, with SLAs that mean something.",
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={cn("antialiased", "font-sans", fontVariables)}>
      <body className="min-h-svh">{children}</body>
    </html>
  )
}
