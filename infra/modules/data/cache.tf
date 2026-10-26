# Redis 7 for BullMQ, the throttler, the tenant cache and quota counters.
# Encrypted at rest under the environment's key.

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
  apply_immediately          = true
}
