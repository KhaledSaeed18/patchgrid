import { Injectable } from "@nestjs/common"

import { InjectConfig, type AppConfig } from "../config/app-config"

/**
 * The public URLs mail and redirects point at. One place, because the shape
 * differs between development (`http`, a port) and production (`https`, none)
 * and every caller would otherwise rediscover that (ADR-0014).
 */
@Injectable()
export class PublicUrls {
  constructor(@InjectConfig() private readonly config: AppConfig) {}

  /** `https://patchgrid.xyz` — the marketing site. */
  marketing(): string {
    return this.origin(null)
  }

  /** `https://app.patchgrid.xyz` — login, the org picker, accepting an invitation. */
  app(path = "/"): string {
    return this.origin("app") + path
  }

  /** `https://<slug>.patchgrid.xyz` — a workspace. */
  workspace(slug: string, path = "/"): string {
    return this.origin(slug) + path
  }

  private origin(label: string | null): string {
    const host = label === null ? this.config.ROOT_DOMAIN : `${label}.${this.config.ROOT_DOMAIN}`
    if (this.config.isProduction) return `https://${host}`
    const port = label === null ? (this.config.WEB_ORIGIN_PORTS[0] ?? 3000) : this.config.WEB_APP_PORT
    return `http://${host}:${String(port)}`
  }
}
