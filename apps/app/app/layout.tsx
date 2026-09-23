import type { Metadata } from "next"

import "@patchgrid/ui/globals.css"
import { fontVariables } from "@patchgrid/ui/lib/fonts"
import { cn } from "@patchgrid/ui/lib/utils"

import { ThemeProvider } from "@/components/theme-provider"

// Tenant-specific titles arrive with TenantProvider in M1; nothing here may be
// statically generated per tenant (ADR-0016).
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
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
