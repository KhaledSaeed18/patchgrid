# PostgreSQL 17 (ADR-0015), in the data subnets, encrypted with the
# environment's key, TLS required. The parameter group pins UTC: every SLA
# comparison assumes it, and `db:doctor` checks it (ADR-0023).

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.data_subnet_ids
}

resource "aws_db_parameter_group" "this" {
  name   = var.name
  family = "postgres17"

  parameter {
    name  = "timezone"
    value = "UTC"
  }
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }
  # A slow query is logged with its plan's cost visible in the trace already;
  # this catches the ones that never reach a span.
  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }
  # Idle-in-transaction sessions hold the row locks invariants depend on.
  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "60000"
  }
}

locals {
  # On RDS the master is the CREATEROLE admin; on Floci it is a superuser that
  # makes one (ADR-0059).
  master_username = var.master_is_superuser ? "patchgrid_master" : "patchgrid_admin"
}

resource "random_password" "db" {
  for_each = toset(["master", "admin", "owner", "app"])
  length   = 40
  special  = false
}

resource "aws_db_instance" "this" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = "17"
  instance_class = var.instance_class

  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = var.kms_key_arn

  # The instance starts with no application database, as Compose's does:
  # the provisioning job creates them as the admin (ADR-0059).
  username = local.master_username
  password = random_password.db["master"].result

  db_subnet_group_name   = aws_db_subnet_group.this.name
  parameter_group_name   = aws_db_parameter_group.this.name
  vpc_security_group_ids = [var.database_security_group_id]
  publicly_accessible    = false
  multi_az               = var.multi_az

  backup_retention_period    = var.backup_retention_days
  copy_tags_to_snapshot      = true
  deletion_protection        = var.deletion_protection
  skip_final_snapshot        = !var.deletion_protection
  final_snapshot_identifier  = var.deletion_protection ? "${var.name}-final" : null
  auto_minor_version_upgrade = true
  apply_immediately          = true
}

locals {
  db_host = aws_db_instance.this.address
  db_port = aws_db_instance.this.port
  # verify-full: the certificate must name the host the connection uses.
  tls = "sslmode=verify-full"

  direct = { for role in ["master", "admin", "owner", "app"] :
  role => "postgresql://${role == "master" ? local.master_username : "patchgrid_${role}"}:${random_password.db[role].result}@${local.db_host}:${local.db_port}" }
}

# What each task is handed, and nothing more: the app role through the pooler
# for the api and worker, the owner for migrations, the admin for provisioning.
resource "aws_secretsmanager_secret" "database" {
  for_each                = toset(["app", "migration", "provision"])
  name                    = "${var.name}/database/${each.key}"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.database["app"].id
  secret_string = jsonencode({
    # Pooled: transaction mode is safe because the tenant setting is
    # transaction-local (ADR-0015). PgBouncer verifies the database's
    # certificate on its side of the hop.
    DATABASE_URL = "postgresql://patchgrid_app:${random_password.db["app"].result}@${var.pooler_host}:${var.pooler_port}/patchgrid"
    # LISTEN is session-scoped, so the outbox wake goes to the database itself (ADR-0049).
    DATABASE_LISTEN_URL = "${local.direct["app"]}/patchgrid?${local.tls}"
  })
}

resource "aws_secretsmanager_secret_version" "migration" {
  secret_id = aws_secretsmanager_secret.database["migration"].id
  secret_string = jsonencode({
    DATABASE_MIGRATION_URL = "${local.direct["owner"]}/patchgrid?${local.tls}"
    # The seed and the verification job also act as the app (ADR-0015).
    DATABASE_URL = "${local.direct["app"]}/patchgrid?${local.tls}"
  })
}

resource "aws_secretsmanager_secret_version" "provision" {
  secret_id = aws_secretsmanager_secret.database["provision"].id
  secret_string = jsonencode(merge(
    {
      DATABASE_ADMIN_URL       = "${var.master_is_superuser ? local.direct["admin"] : local.direct["master"]}/postgres?${local.tls}"
      PATCHGRID_OWNER_PASSWORD = random_password.db["owner"].result
      PATCHGRID_APP_PASSWORD   = random_password.db["app"].result
    },
    # Only where the master is a superuser, and only for the instance step.
    var.master_is_superuser ? { DATABASE_SUPERUSER_URL = "${local.direct["master"]}/postgres?${local.tls}" } : {},
  ))
}

# PgBouncer authenticates its clients as the app role, and the app role alone.
resource "aws_secretsmanager_secret" "pooler" {
  name                    = "${var.name}/database/pooler"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "pooler" {
  secret_id = aws_secretsmanager_secret.pooler.id
  secret_string = jsonencode({
    DB_HOST     = local.db_host
    DB_PORT     = tostring(local.db_port)
    DB_USER     = "patchgrid_app"
    DB_PASSWORD = random_password.db["app"].result
  })
}
