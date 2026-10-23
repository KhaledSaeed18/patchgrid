# The long-running workloads, rolled forward by `pnpm aws:deploy` after the
# migrations have run (ADR-0058).
#
#   pgbouncer  transaction-mode pooling in front of RDS, at pgbouncer.<namespace>
#   api        the HTTP API (WORKER_MODE=api), behind the load balancer
#   worker     the queues and sweeps (WORKER_MODE=worker), behind nothing
#   app, www   the frontends, behind the load balancer

locals {
  network  = local.platform.network
  cluster  = local.platform.cluster
  roles    = local.cluster.task_role_arns
  database = local.platform.secrets.app
  groups   = local.network.security_groups
  in_vpc   = { subnet_ids = local.network.app_subnet_ids }

  # api and worker share an image and everything but WORKER_MODE.
  backend_database = {
    DATABASE_URL        = "${local.database}:DATABASE_URL::"
    DATABASE_LISTEN_URL = "${local.database}:DATABASE_LISTEN_URL::"
  }
  node_health = ["CMD", "node", "-e", "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
}

module "pgbouncer" {
  source        = "../../../modules/ecs-service"
  name          = "pgbouncer"
  family_prefix = local.platform.name
  cluster_arn   = local.cluster.arn
  image         = local.image["pgbouncer"]
  port          = 6432
  environment = {
    LISTEN_PORT = "6432"
    DB_NAME     = "patchgrid"
    # Safe because the tenant is set transaction-locally (ADR-0015): a pooled
    # server connection carries no tenant from one transaction to the next.
    POOL_MODE         = "transaction"
    AUTH_TYPE         = "scram-sha-256"
    MAX_CLIENT_CONN   = "500"
    DEFAULT_POOL_SIZE = "20"
    # Protocol-level prepared statements, tracked per client (PgBouncer 1.21+).
    MAX_PREPARED_STATEMENTS   = "200"
    IGNORE_STARTUP_PARAMETERS = "extra_float_digits"
  }
  secrets = {
    for name in ["DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD"] :
    name => "${local.platform.secrets.pooler}:${name}::"
  }
  execution_role_arn = local.cluster.execution_role_arn
  task_role_arn      = local.roles.none
  log_group          = local.cluster.log_groups.pgbouncer
  region             = local.platform.region
  cpu_architecture   = var.cpu_architecture
  service = merge(local.in_vpc, {
    desired_count          = 1
    security_group_id      = local.groups.pooler
    discovery_namespace_id = local.cluster.namespace_id
  })
}

module "api" {
  source        = "../../../modules/ecs-service"
  name          = "api"
  family_prefix = local.platform.name
  cluster_arn   = local.cluster.arn
  image         = local.image["api"]
  cpu           = 512
  memory        = 1024
  port          = 4000
  environment   = merge(local.backend_environment, { WORKER_MODE = "api", OTEL_SERVICE_NAME = "patchgrid-api" })
  secrets       = merge(local.backend_secrets, local.backend_database)
  health_check  = local.node_health

  execution_role_arn = local.cluster.execution_role_arn
  task_role_arn      = local.roles.backend
  log_group          = local.cluster.log_groups.api
  region             = local.platform.region
  cpu_architecture   = var.cpu_architecture
  service = merge(local.in_vpc, {
    desired_count     = 2
    security_group_id = local.groups.api
    target_group_arn  = local.platform.target_groups.api
  })
  depends_on = [module.pgbouncer]
}

module "worker" {
  source        = "../../../modules/ecs-service"
  name          = "worker"
  family_prefix = local.platform.name
  cluster_arn   = local.cluster.arn
  image         = local.image["api"]
  cpu           = 512
  memory        = 1024
  environment   = merge(local.backend_environment, { WORKER_MODE = "worker", OTEL_SERVICE_NAME = "patchgrid-worker" })
  secrets       = merge(local.backend_secrets, local.backend_database)
  health_check  = local.node_health
  # A job in flight finishes before the process exits (BullMQ's graceful close).
  stop_timeout = 60

  execution_role_arn = local.cluster.execution_role_arn
  task_role_arn      = local.roles.backend
  log_group          = local.cluster.log_groups.worker
  region             = local.platform.region
  cpu_architecture   = var.cpu_architecture
  service = merge(local.in_vpc, {
    desired_count     = 1
    security_group_id = local.groups.api
  })
  depends_on = [module.pgbouncer]
}

module "frontend" {
  source   = "../../../modules/ecs-service"
  for_each = toset(["app", "www"])

  name          = each.key
  family_prefix = local.platform.name
  cluster_arn   = local.cluster.arn
  image         = local.image[each.key]
  port          = 3000
  environment   = { PORT = "3000", HOSTNAME = "0.0.0.0" }
  health_check  = ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

  execution_role_arn = local.cluster.execution_role_arn
  task_role_arn      = local.roles.none
  log_group          = local.cluster.log_groups[each.key]
  region             = local.platform.region
  cpu_architecture   = var.cpu_architecture
  service = merge(local.in_vpc, {
    desired_count     = each.key == "app" ? 2 : 1
    security_group_id = local.groups.web
    target_group_arn  = local.platform.target_groups[each.key]
  })
}

output "services" {
  value = concat(["pgbouncer", "api", "worker"], [for name, _ in module.frontend : name])
}

output "urls" {
  value = {
    www = "https://${local.platform.root_domain}"
    app = "https://app.${local.platform.root_domain}"
    api = "https://api.${local.platform.root_domain}/api/v1"
  }
}
