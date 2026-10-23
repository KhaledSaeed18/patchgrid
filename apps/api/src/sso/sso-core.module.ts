import { Module } from "@nestjs/common"

import { DOMAIN_RESOLVER, SystemDomainResolver } from "./domain-resolver"
import { OidcClient } from "./oidc-client"
import { OrgDomainRepository } from "./repositories/org-domain.repository"
import { SsoConnectionRepository } from "./repositories/sso-connection.repository"
import { SsoIdentityRepository } from "./repositories/sso-identity.repository"
import { SsoSecrets } from "./sso-secrets"

/**
 * What both sides of SSO share (ADR-0054): the settings an owner keeps and
 * the sign-in the auth routes run. Free of the auth module, so it can import
 * this without a cycle.
 */
@Module({
  providers: [OrgDomainRepository, SsoConnectionRepository, SsoIdentityRepository, SsoSecrets, OidcClient, { provide: DOMAIN_RESOLVER, useClass: SystemDomainResolver }],
  exports: [OrgDomainRepository, SsoConnectionRepository, SsoIdentityRepository, SsoSecrets, OidcClient, DOMAIN_RESOLVER],
})
export class SsoCoreModule {}
