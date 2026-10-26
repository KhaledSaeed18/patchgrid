# Everything that outlives a release: the network, the keys and secrets, the
# database, the cache, the bucket, the registry, the way in, mail, and the
# cluster with its roles. `jobs` and `services` read this root's outputs.

locals {
  name        = "patchgrid-local"
  root_domain = "patchgrid.test"
  pooler_host = "pgbouncer.${replace(local.name, "-", ".")}.internal"
}

module "network" {
  source             = "../../../modules/network"
  name               = local.name
  availability_zones = ["${var.region}a", "${var.region}b"]
}

module "secrets" {
  source = "../../../modules/secrets"
  name   = local.name
}

module "data" {
  source                     = "../../../modules/data"
  name                       = local.name
  kms_key_arn                = module.secrets.kms_key_arn
  data_subnet_ids            = module.network.data_subnet_ids
  database_security_group_id = module.network.security_groups.database
  cache_security_group_id    = module.network.security_groups.cache
  pooler_host                = local.pooler_host
  # Floci's master is a superuser; RDS's is not (ADR-0059).
  master_is_superuser = true
  deletion_protection = false
  web_origins         = ["https://${local.root_domain}", "https://*.${local.root_domain}"]
  # Floci's cache proxy speaks AUTH but not TLS, and AWS takes a token only
  # with TLS, so the local cache has neither. True everywhere else.
  cache_transit_encryption = false
}

module "registry" {
  source       = "../../../modules/registry"
  name         = local.name
  repositories = ["api", "tools", "app", "www", "pgbouncer"]
  kms_key_arn  = module.secrets.kms_key_arn
}

module "edge" {
  source                = "../../../modules/edge"
  name                  = local.name
  root_domain           = local.root_domain
  vpc_id                = module.network.vpc_id
  public_subnet_ids     = module.network.public_subnet_ids
  alb_security_group_id = module.network.security_groups.alb
  deletion_protection   = false
}

module "mail" {
  source               = "../../../modules/mail"
  domain               = local.root_domain
  public_zone_id       = module.edge.public_zone_id
  dmarc_report_address = "dmarc@${local.root_domain}"
}

module "cluster" {
  source      = "../../../modules/cluster"
  name        = local.name
  vpc_id      = module.network.vpc_id
  kms_key_arn = module.secrets.kms_key_arn
  secret_arns = concat([module.secrets.app_secret_arn, module.data.cache_secret_arn], values(module.data.database_secret_arns))

  repository_arns   = module.registry.repository_arns
  files_bucket_arn  = module.data.files_bucket.arn
  mail_identity_arn = module.mail.identity_arn
  log_groups        = ["api", "worker", "app", "www", "pgbouncer", "jobs"]
}
