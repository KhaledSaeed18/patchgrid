import type { Metadata } from "next"
import { Geist_Mono, Inter } from "next/font/google"

import "@patchgrid/ui/globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { cn } from "@patchgrid/ui/lib/utils";

const inter = Inter({subsets:['latin'],variable:'--font-sans'})

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

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
      className={cn("antialiased", fontMono.variable, "font-sans", inter.variable)}
    >
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
