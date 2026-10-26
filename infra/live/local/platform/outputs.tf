# What `jobs` and `services` build on, and what `pnpm aws:*` needs to run a task.

output "name" {
  value = local.name
}

output "root_domain" {
  value = local.root_domain
}

output "region" {
  value = var.region
}

output "network" {
  value = {
    vpc_id          = module.network.vpc_id
    app_subnet_ids  = module.network.app_subnet_ids
    security_groups = module.network.security_groups
  }
}

output "cluster" {
  value = {
    arn                = module.cluster.cluster.arn
    name               = module.cluster.cluster.name
    namespace_id       = module.cluster.namespace.id
    execution_role_arn = module.cluster.execution_role_arn
    task_role_arns     = module.cluster.task_role_arns
    log_groups         = module.cluster.log_groups
  }
}

# The API's keys under `keys`, never `app`: the database secrets are keyed by
# role, `app` is one of them, and merge() keeps the last.
output "secrets" {
  value = merge({ keys = module.secrets.app_secret_arn }, module.data.database_secret_arns)
}

output "redis_url" {
  value = module.data.redis_url
}

output "files_bucket" {
  value = module.data.files_bucket.name
}

output "repositories" {
  value = module.registry.repository_urls
}

output "target_groups" {
  value = module.edge.target_group_arns
}

output "pooler_host" {
  value = local.pooler_host
}

output "load_balancer_dns_name" {
  value = module.edge.load_balancer.dns_name
}
