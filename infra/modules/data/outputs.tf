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

output "cache_secret_arn" {
  description = "REDIS_URL, with its AUTH token when transit encryption is on."
  value       = aws_secretsmanager_secret.cache.arn
}

output "files_bucket" {
  value = {
    name = aws_s3_bucket.files.id
    arn  = aws_s3_bucket.files.arn
  }
}
