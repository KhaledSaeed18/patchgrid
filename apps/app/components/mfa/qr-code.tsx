"use client"

import QRCode from "qrcode"
import { useEffect, useState } from "react"

/** The authenticator's QR code, drawn here: the secret never leaves the browser for an image service. */
export function QrCode({ value }: { value: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void QRCode.toDataURL(value, { margin: 1, width: 192 }).then((url) => {
      if (live) setSrc(url)
    })
    return () => {
      live = false
    }
  }, [value])
  return src === null ? (
    <div className="size-48 rounded-md bg-muted" />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element -- a data URL drawn in the browser, not an asset to optimise
    <img
      src={src}
      alt="QR code for your authenticator app"
      className="size-48 rounded-md border border-border"
    />
  )
}
