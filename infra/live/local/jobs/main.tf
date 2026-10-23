# One-off tasks, run by `pnpm aws:deploy` before services roll (ADR-0058), and
# by hand with `pnpm aws:run <job>`. Task definitions only: each is started with
# RunTask on the jobs security group, and exits.
#
#   provision  roles, databases and grants, as the admin (ADR-0059)
#   migrate    `prisma migrate deploy`, as the owner
#   seed       the two demo workspaces
#   verify     the tenancy isolation suite, from inside the VPC, through PgBouncer

locals {
  migration = local.platform.secrets.migration
  provision = local.platform.secrets.provision

  jobs = {
    provision = {
      command = ["pnpm", "run", "bootstrap"]
      environment = {
        POSTGRES_DB         = "patchgrid"
        BOOTSTRAP_DATABASES = "patchgrid"
        POSTGRES_SHADOW_DB  = ""
      }
      secrets = {
        for name in ["DATABASE_ADMIN_URL", "DATABASE_SUPERUSER_URL", "PATCHGRID_OWNER_PASSWORD", "PATCHGRID_APP_PASSWORD"] :
        name => "${local.provision}:${name}::"
      }
    }
    migrate = {
      command     = ["pnpm", "run", "migrate:deploy"]
      environment = {}
      secrets     = { DATABASE_MIGRATION_URL = "${local.migration}:DATABASE_MIGRATION_URL::" }
    }
    seed = {
      command     = ["pnpm", "run", "seed"]
      environment = {}
      secrets = {
        DATABASE_MIGRATION_URL = "${local.migration}:DATABASE_MIGRATION_URL::"
        SSO_SECRETS_KEY        = "${local.app_secret}:SSO_SECRETS_KEY::"
      }
    }
    verify = {
      # The suite that gates every release, against this environment: the app
      # role through the pooler, so transaction-mode pooling is what is tested.
      command     = ["sh", "-c", "cd /repo && pnpm --filter @patchgrid/api run test:tenancy"]
      environment = merge(local.backend_environment, { NODE_ENV = "test", S3_ENDPOINT = "https://floci:4566" })
      secrets = merge(local.backend_secrets, {
        DATABASE_URL           = "${local.platform.secrets.app}:DATABASE_URL::"
        DATABASE_LISTEN_URL    = "${local.platform.secrets.app}:DATABASE_LISTEN_URL::"
        DATABASE_MIGRATION_URL = "${local.migration}:DATABASE_MIGRATION_URL::"
      })
    }
  }
}

module "job" {
  source   = "../../../modules/ecs-service"
  for_each = local.jobs

  name          = each.key
  family_prefix = "${local.platform.name}-job"
  cluster_arn   = local.platform.cluster.arn
  image         = local.image["tools"]
  cpu           = 512
  memory        = 1024
  command       = each.value.command
  environment   = each.value.environment
  secrets       = each.value.secrets

  execution_role_arn = local.platform.cluster.execution_role_arn
  task_role_arn      = local.platform.cluster.task_role_arns.backend
  log_group          = local.platform.cluster.log_groups.jobs
  region             = local.platform.region
  cpu_architecture   = var.cpu_architecture
}

output "task_definitions" {
  value = { for name, job in module.job : name => job.task_definition_arn }
}

output "run" {
  description = "What RunTask needs for every job."
  value = {
    cluster         = local.platform.cluster.name
    subnets         = local.platform.network.app_subnet_ids
    security_groups = [local.platform.network.security_groups.jobs]
  }
}
