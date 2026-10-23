import { describe, expect, it } from "vitest"

import { sniff } from "./sniff"

const bytes = (...parts: (string | number[])[]) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)))
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

describe("byte sniffing (ADR-0005)", () => {
  it("accepts a file whose first bytes agree with what it claims", () => {
    expect(sniff(bytes(PNG, "rest"), "image/png")).toBe("image/png")
    expect(sniff(bytes([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg")).toBe("image/jpeg")
    expect(sniff(bytes("GIF89a…"), "image/gif")).toBe("image/gif")
    expect(sniff(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 "), "image/webp")).toBe("image/webp")
    expect(sniff(bytes("%PDF-1.7\n"), "application/pdf")).toBe("application/pdf")
  })

  it("lets a zip container be the Office format it says, and an OLE file the old one", () => {
    const zip = bytes([0x50, 0x4b, 0x03, 0x04], "…")
    expect(sniff(zip, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
    expect(sniff(zip, "application/zip")).toBe("application/zip")
    expect(sniff(bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), "application/vnd.ms-excel")).toBe("application/vnd.ms-excel")
  })

  it("refuses a file that is something other than it claims", () => {
    expect(sniff(bytes("%PDF-1.7"), "image/png")).toBeNull()
    expect(sniff(bytes(PNG), "application/pdf")).toBeNull()
    expect(sniff(bytes([0x50, 0x4b, 0x03, 0x04]), "image/png")).toBeNull()
    expect(sniff(bytes(PNG), "text/plain")).toBeNull()
  })

  it("takes text only when it is text — never markup a browser would render", () => {
    expect(sniff(bytes("2026-10-14 09:00 vpn dropped\n"), "text/plain")).toBe("text/plain")
    expect(sniff(bytes("name,email\nada,ada@x\n"), "text/csv")).toBe("text/csv")
    expect(sniff(bytes('{"ok":true}'), "application/json")).toBe("application/json")
    expect(sniff(bytes("Ünïcode ✓"), "text/plain")).toBe("text/plain")
    for (const page of [
      "<!DOCTYPE html><p>hi",
      "  <svg onload=alert(1)>",
      "﻿<html>",
      "<?xml version='1.0'?><svg/>",
      "<script>x</script>",
    ]) {
      expect(sniff(bytes(page), "text/plain"), page).toBeNull()
    }
    expect(sniff(bytes("abc", [0], "def"), "text/plain")).toBeNull()
    expect(sniff(Uint8Array.from([0xc3, 0x28]), "text/plain")).toBeNull()
  })

  it("forgives a sample cut in the middle of a character", () => {
    const text = new TextEncoder().encode("café ✓")
    expect(sniff(text.subarray(0, text.length - 1), "text/plain")).toBe("text/plain")
  })
})
