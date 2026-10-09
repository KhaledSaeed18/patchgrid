import type { Metadata } from "next"

import "@patchgrid/ui/globals.css"
import { fontVariables } from "@patchgrid/ui/lib/fonts"
import { cn } from "@patchgrid/ui/lib/utils"

import { Providers } from "@/components/providers"

// Nothing here may be statically generated per tenant (ADR-0016); workspace
// pages set their own titles from the workspace they render.
export const metadata: Metadata = {
  title: { default: "Patchgrid", template: "%s · Patchgrid" },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("antialiased", "font-sans", fontVariables)}
    >
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
