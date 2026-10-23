"use client"

import { useEffect } from "react"
import { toast } from "sonner"

import { SSO_ERROR_MESSAGE, ssoErrorFrom } from "@/lib/sso"

/**
 * A step-up at the workspace's identity provider that came back refused
 * lands here with `?sso=<code>` (ADR-0054): say why once, then drop the code
 * from the address so a reload does not say it again.
 */
export function SsoNotice() {
  useEffect(() => {
    const url = new URL(window.location.href)
    const code = ssoErrorFrom(url.searchParams.get("sso"))
    if (code === null) return
    toast.error(SSO_ERROR_MESSAGE[code])
    url.searchParams.delete("sso")
    window.history.replaceState(null, "", url.pathname + url.search + url.hash)
  }, [])
  return null
}
