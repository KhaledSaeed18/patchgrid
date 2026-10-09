import { type NextRequest, NextResponse } from "next/server"

import { appOrigin, ROOT_DOMAIN } from "@/lib/config"
import { decideRoute, PATH_HEADER, SLUG_HEADER } from "@/lib/routing"

/**
 * Host routing and the session gate (ADR-0014, ADR-0035). The decision is
 * `decideRoute`'s; this only applies it. Server components learn the
 * workspace and the page they are rendering from the two headers above, which
 * is how server-side `apiFetch` names its tenant and its way back.
 *
 * Not an authorization layer: the API decides every request on its own. This
 * decides where to send a browser.
 */
export function proxy(request: NextRequest): NextResponse {
  const decision = decideRoute({
    host: request.headers.get("host"),
    // The Host the browser used, not nextUrl's: in development that is normalised to localhost.
    origin: `${request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "")}://${request.headers.get("host") ?? request.nextUrl.host}`,
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    cookies: (name) => request.cookies.get(name)?.value,
    nowSeconds: Math.floor(Date.now() / 1000),
    rootDomain: ROOT_DOMAIN,
    appOrigin: appOrigin(),
  })

  switch (decision.kind) {
    case "redirect":
      return NextResponse.redirect(new URL(decision.to, request.url))
    case "not-found":
      return new NextResponse("Not found", {
        status: 404,
        headers: { "content-type": "text/plain" },
      })
    case "next": {
      const headers = new Headers(request.headers)
      headers.delete(SLUG_HEADER)
      if (decision.slug !== null) headers.set(SLUG_HEADER, decision.slug)
      headers.set(
        PATH_HEADER,
        request.nextUrl.pathname + request.nextUrl.search
      )
      return NextResponse.next({ request: { headers } })
    }
  }
}

export const config = {
  // Everything but the framework's own assets and the container's health probe.
  matcher: ["/((?!_next/|favicon.ico|api/health).*)"],
}
