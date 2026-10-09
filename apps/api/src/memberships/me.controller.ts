import { Controller, Get } from "@nestjs/common"
import type { Me } from "@patchgrid/contracts"

import { RequirePermission } from "../authz/require-permission"
import { MeService } from "./me.service"

/**
 * `GET /me`. Every role holds `member:read`, and the caller is a member —
 * so the route's filter admits anyone in the workspace, by the catalog
 * rather than by an exemption.
 */
@Controller("me")
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get()
  @RequirePermission("member:read")
  get(): Promise<Me> {
    return this.me.me()
  }
}
