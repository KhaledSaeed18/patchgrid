# What every backend task (api, worker, jobs) is told about its environment,
# beside its secrets. The values a real account changes are the endpoint, the
# files origin and the path style; everything else is the product's own.
locals {
  backend_environment = {
    NODE_ENV    = "production"
    LOG_LEVEL   = "info"
    ROOT_DOMAIN = local.platform.root_domain
    # Origins carry no port behind TLS; the schema insists.
    WEB_ORIGIN_PORTS = ""
    COOKIE_DOMAIN    = ".${local.platform.root_domain}"
    REDIS_URL        = local.platform.redis_url

    AWS_REGION = local.platform.region
    # Floci, for every AWS client in the application. Unset on AWS, where the
    # SDK resolves each service's regional endpoint (ADR-0058).
    AWS_ENDPOINT_URL    = "https://floci:4566"
    S3_REGION           = local.platform.region
    S3_BUCKET           = local.platform.files_bucket
    S3_FORCE_PATH_STYLE = "true"
    # Where browsers PUT and GET: S3's own origin, another registrable domain
    # than the product's (ADR-0037). On AWS: https://<bucket>.s3.<region>.amazonaws.com.
    FILES_PUBLIC_ORIGIN = "https://localhost:4566"

    MAIL_TRANSPORT      = "ses"
    MAIL_FROM           = "Patchgrid <notifications@${local.platform.root_domain}>"
    INBOUND_AUTHSERV_ID = "mx.inbound.${local.platform.root_domain}"
    # One hop: the load balancer (THREAT-MODEL.md §7).
    TRUST_PROXY_HOPS = "1"
  }

  app_secret = local.platform.secrets.app
  backend_secrets = {
    for name in ["JWT_SECRET", "MFA_ENCRYPTION_KEY", "WEBHOOK_SECRETS_KEY", "SSO_SECRETS_KEY", "INBOUND_WEBHOOK_SECRET"] :
    name => "${local.app_secret}:${name}::"
  }

  image = { for name, url in local.platform.repositories : name => "${url}:${var.image_tag}" }
}
