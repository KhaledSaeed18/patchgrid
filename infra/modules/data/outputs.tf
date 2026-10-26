output "database" {
  value = {
    address = aws_db_instance.this.address
    port    = aws_db_instance.this.port
  }
}

output "database_secret_arns" {
  description = "app (api, worker), migration (migrations, seed, verify), provision (the provisioning job), pooler (PgBouncer)."
  value = {
    app       = aws_secretsmanager_secret.database["app"].arn
    migration = aws_secretsmanager_secret.database["migration"].arn
    provision = aws_secretsmanager_secret.database["provision"].arn
    pooler    = aws_secretsmanager_secret.pooler.arn
  }
}

output "redis_url" {
  value = "redis://${aws_elasticache_replication_group.this.primary_endpoint_address}:${aws_elasticache_replication_group.this.port}"
}

output "files_bucket" {
  value = {
    name = aws_s3_bucket.files.id
    arn  = aws_s3_bucket.files.arn
  }
}
