# Redis 7 for BullMQ, the throttler, the tenant cache and quota counters.
# Encrypted at rest under the environment's key, and in transit behind an AUTH
# token, as RDS takes only TLS. AWS accepts a token only with transit
# encryption, so the two go together.

resource "aws_elasticache_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.data_subnet_ids
}

resource "aws_elasticache_parameter_group" "this" {
  name   = var.name
  family = "redis7"

  # BullMQ's own requirement: a queue key evicted under memory pressure is a
  # lost job, so Redis refuses writes instead.
  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }
}

resource "random_password" "cache" {
  length  = 64
  special = false
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = var.name
  description          = "${var.name}: queues, throttling, caches"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.cache_node_type
  port                 = 6379

  num_cache_clusters         = 1 + var.cache_replicas
  automatic_failover_enabled = var.cache_replicas > 0
  multi_az_enabled           = var.cache_replicas > 0

  subnet_group_name    = aws_elasticache_subnet_group.this.name
  parameter_group_name = aws_elasticache_parameter_group.this.name
  security_group_ids   = [var.cache_security_group_id]

  at_rest_encryption_enabled = true
  kms_key_id                 = var.kms_key_arn
  transit_encryption_enabled = var.cache_transit_encryption
  auth_token                 = var.cache_transit_encryption ? random_password.cache.result : null
  apply_immediately          = true
}

locals {
  cache = aws_elasticache_replication_group.this
  cache_url = (var.cache_transit_encryption
    ? "rediss://:${random_password.cache.result}@${local.cache.primary_endpoint_address}:${local.cache.port}"
  : "redis://${local.cache.primary_endpoint_address}:${local.cache.port}")
}

# The URL carries the token, so it is a secret, injected like the database's.
resource "aws_secretsmanager_secret" "cache" {
  name                    = "${var.name}/cache"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "cache" {
  secret_id     = aws_secretsmanager_secret.cache.id
  secret_string = jsonencode({ REDIS_URL = local.cache_url })
}
