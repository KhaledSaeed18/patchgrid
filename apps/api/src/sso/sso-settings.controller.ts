import { Body, Controller, Get, HttpCode, Post, Put } from "@nestjs/common"
import {
  domainJoinRequestSchema,
  orgDomainRequestSchema,
  ssoConnectionRequestSchema,
  ssoRequirementRequestSchema,
  type SsoSettings,
} from "@patchgrid/contracts"
import { createZodDto } from "nestjs-zod"

import { RequirePermission } from "../authz/require-permission"
import { SsoSettingsService } from "./sso-settings.service"

class OrgDomainDto extends createZodDto(orgDomainRequestSchema) {}
class SsoConnectionDto extends createZodDto(ssoConnectionRequestSchema) {}
class SsoRequirementDto extends createZodDto(ssoRequirementRequestSchema) {}
class DomainJoinDto extends createZodDto(domainJoinRequestSchema) {}

/** The current workspace's domain proof and single sign-on (ADR-0054). Owner-only throughout. */
@Controller("org")
export class SsoSettingsController {
  constructor(private readonly sso: SsoSettingsService) {}

  @Get("sso")
  @RequirePermission("org:manage_sso")
  get(): Promise<SsoSettings> {
    return this.sso.get()
  }

  /** Claims the domain (unproved, with a fresh TXT challenge), or `{ domain: null }` to remove it. */
  @Put("domain")
  @RequirePermission("org:manage_domain")
  claimDomain(@Body() body: OrgDomainDto): Promise<SsoSettings> {
    return this.sso.claimDomain(body)
  }

  /** Looks the TXT record up now. `409` until it carries the challenge. */
  @Post("domain/verification")
  @HttpCode(200)
  @RequirePermission("org:manage_domain")
  verifyDomain(): Promise<SsoSettings> {
    return this.sso.verifyDomain()
  }

  /** A step-up action: it lets anyone with a verified address at the proved domain join (TENANCY.md §5). */
  @Put("domain/join")
  @RequirePermission("org:manage_domain")
  setDomainJoin(@Body() body: DomainJoinDto): Promise<SsoSettings> {
    return this.sso.setDomainJoin(body)
  }

  /** A step-up action: whoever controls the connection can sign in as anyone at the domain. */
  @Put("sso/connection")
  @RequirePermission("org:manage_sso")
  saveConnection(@Body() body: SsoConnectionDto): Promise<SsoSettings> {
    return this.sso.saveConnection(body)
  }

  @Put("sso/requirement")
  @RequirePermission("org:manage_sso")
  setRequirement(@Body() body: SsoRequirementDto): Promise<SsoSettings> {
    return this.sso.setRequirement(body)
  }
}
