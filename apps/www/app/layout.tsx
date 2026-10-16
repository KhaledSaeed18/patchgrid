import type { Metadata } from "next"

import "./globals.css"
import { fontVariables } from "@patchgrid/ui/lib/fonts"
import { cn } from "@patchgrid/ui/lib/utils"

import { SITE_URL } from "@/lib/config"
import { SITE_NAME } from "@/lib/metadata"

export const metadata: Metadata = {
  // Canonical addresses and Open Graph images are relative; crawlers need them whole.
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Patchgrid — IT service management",
    template: "%s · Patchgrid",
  },
  description:
    "A multi-tenant ITSM platform: incidents, service requests, problems and changes, with SLAs that mean something.",
  applicationName: SITE_NAME,
  openGraph: { siteName: SITE_NAME, locale: "en_GB", type: "website" },
  twitter: { card: "summary_large_image" },
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
