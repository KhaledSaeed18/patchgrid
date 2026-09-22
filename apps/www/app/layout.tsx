import type { Metadata } from "next"
import { Geist_Mono, Inter } from "next/font/google"

import "@patchgrid/ui/globals.css"
import { cn } from "@patchgrid/ui/lib/utils"

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" })
const fontMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" })

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
    <html
      lang="en"
      className={cn("antialiased", fontMono.variable, "font-sans", inter.variable)}
    >
      <body className="min-h-svh">{children}</body>
    </html>
  )
}
