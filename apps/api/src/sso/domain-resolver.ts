import { Inject, Injectable } from "@nestjs/common"
import { Resolver } from "node:dns/promises"

import { type AppConfig, InjectConfig } from "../config/app-config"

/** The TXT records at a name, each joined from its strings; empty when there are none. */
export type DomainResolver = { txt(name: string): Promise<string[]> }

export const DOMAIN_RESOLVER = Symbol("DOMAIN_RESOLVER")
export const InjectDomainResolver = (): ParameterDecorator => Inject(DOMAIN_RESOLVER)

/** Answers that mean "no such record", as opposed to a resolver that could not be asked. */
const ABSENT = new Set(["ENODATA", "ENOTFOUND", "NXDOMAIN"])

/** Raised when the nameservers could not answer: the proof is neither passed nor failed. */
export class DnsUnavailableError extends Error {}

/**
 * The domain proof's view of DNS (ADR-0054): `node:dns`, pointed at
 * `DNS_RESOLVERS` when set — a local nameserver can stand in for DNS nobody
 * can publish to. Specs inject their own.
 */
@Injectable()
export class SystemDomainResolver implements DomainResolver {
  private readonly resolver = new Resolver({ timeout: 3_000, tries: 2 })

  constructor(@InjectConfig() config: AppConfig) {
    if (config.DNS_RESOLVERS.length > 0) this.resolver.setServers(config.DNS_RESOLVERS)
  }

  async txt(name: string): Promise<string[]> {
    try {
      return (await this.resolver.resolveTxt(name)).map((chunks) => chunks.join(""))
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : ""
      if (ABSENT.has(code)) return []
      throw new DnsUnavailableError(code)
    }
  }
}
