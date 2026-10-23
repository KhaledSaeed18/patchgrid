import { Body, Controller, Get, HttpCode, Post, Query, Req, Res } from "@nestjs/common"
import { Throttle } from "@nestjs/throttler"
import { IDENTITY_COOKIE, SSO_FLOW_COOKIE, SSO_FLOW_COOKIE_PATH, ssoDiscoverRequestSchema, type SsoDiscoverResponse, ssoStartQuerySchema } from "@patchgrid/contracts"
import type { Request, Response } from "express"
import { createZodDto } from "nestjs-zod"
import { z } from "zod"

import { Public } from "../../common/decorators/route-markers"
import { PublicUrls } from "../../common/urls"
import { clientOf } from "../auth.controller"
import { CookieService, readCookie } from "../cookies"
import { SsoFailure } from "./sso-provisioning"
import { type SsoRedirect, SsoSignInService } from "./sso-sign-in.service"

class SsoDiscoverDto extends createZodDto(ssoDiscoverRequestSchema) {}
class SsoStartDto extends createZodDto(ssoStartQuerySchema) {}
/** What an identity provider sends back; anything else in the query is ignored here and checked by `openid-client`. */
class SsoCallbackDto extends createZodDto(
  z.object({ code: z.string().max(4096).optional(), state: z.string().max(512).optional(), error: z.string().max(256).optional() }).loose(),
) {}

/**
 * Single sign-on through a workspace's identity provider (ADR-0054). Public:
 * the browser is on its way to a session, not holding one. `start` and
 * `callback` are top-level navigations that answer with a redirect, never
 * JSON, and a failure redirects too, carrying one of a fixed set of codes.
 */
@Controller("auth/sso")
@Throttle({ ip: { limit: 20, ttl: 60_000 } })
export class SsoController {
  constructor(
    private readonly sso: SsoSignInService,
    private readonly cookies: CookieService,
    private readonly urls: PublicUrls,
  ) {}

  @Post("discover")
  @Public()
  @HttpCode(200)
  discover(@Body() body: SsoDiscoverDto): Promise<SsoDiscoverResponse> {
    return this.sso.discover(body.email)
  }

  @Get("start")
  @Public()
  async start(@Query() query: SsoStartDto, @Req() request: Request, @Res() response: Response): Promise<void> {
    const fetchSite = request.headers["sec-fetch-site"]
    await this.redirect(response, () => this.sso.start(query, typeof fetchSite === "string" ? fetchSite : undefined))
  }

  @Get("callback")
  @Public()
  async callback(@Query() query: SsoCallbackDto, @Req() request: Request, @Res() response: Response): Promise<void> {
    // `openid-client` reads the code and state from the URL the provider sent the browser to.
    const callbackUrl = new URL(this.urls.ssoCallback())
    callbackUrl.search = new URL(request.originalUrl, callbackUrl).search
    // The flow is single-use whatever happens next; so is its cookie.
    this.cookies.clear(response, [{ name: SSO_FLOW_COOKIE, path: SSO_FLOW_COOKIE_PATH }])
    await this.redirect(response, () =>
      this.sso.callback(
        { ...(query.code === undefined ? {} : { code: query.code }), ...(query.state === undefined ? {} : { state: query.state }), ...(query.error === undefined ? {} : { error: query.error }) },
        callbackUrl,
        readCookie(request, SSO_FLOW_COOKIE),
        readCookie(request, IDENTITY_COOKIE),
        clientOf(request),
      ),
    )
  }

  private async redirect(response: Response, run: () => Promise<SsoRedirect>): Promise<void> {
    let target: string
    try {
      const result = await run()
      this.cookies.set(response, result.cookies)
      target = result.location
    } catch (error) {
      if (!(error instanceof SsoFailure)) throw error
      target = this.sso.failureLocation(error)
    }
    // Nothing about the flow belongs in a cache or a referrer.
    response.setHeader("Cache-Control", "no-store")
    response.setHeader("Referrer-Policy", "no-referrer")
    response.redirect(302, target)
  }
}
