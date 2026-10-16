import type { MetadataRoute } from "next"

import { SITE_URL } from "@/lib/config"

/** Everything here is public by design; the product lives on other hosts. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: new URL("/sitemap.xml", SITE_URL).toString(),
  }
}
