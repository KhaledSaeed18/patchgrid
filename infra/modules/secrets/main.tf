# The environment's key, and the application's secrets encrypted under it
# (ADR-0058). Every value is generated here and never leaves AWS but into a
# task's environment, through ECS's `secrets` (the execution role reads them,
# the application never calls Secrets Manager itself).
#
# The 32-byte keys are the ones ADR-0040, ADR-0050 and ADR-0054 keep apart from
# the database: a snapshot of RDS without this secret yields no second factors,
# signs no webhooks and authenticates to no identity provider.

variable "name" {
  type = string
}

variable "disposable" {
  description = "An environment thrown away whole (Floci): deletions are immediate and keep nothing. Off by default, which keeps everything."
  type        = bool
  default     = false
}

data "aws_caller_identity" "this" {}
data "aws_region" "this" {}

# The account administers the key through IAM, as the default policy allows;
# CloudWatch Logs needs its own grant to encrypt log groups, scoped to this
# account's log groups by encryption context.
data "aws_iam_policy_document" "key" {
  statement {
    sid       = "AccountAdministers"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.this.account_id}:root"]
    }
  }
  statement {
    sid       = "LogsEncrypt"
    actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${data.aws_region.this.region}.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${data.aws_region.this.region}:${data.aws_caller_identity.this.account_id}:log-group:*"]
    }
  }
}

resource "aws_kms_key" "this" {
  description         = "${var.name}: secrets, the database, the cache, object storage, images and logs"
  enable_key_rotation = true
  # Thirty days, AWS's longest: everything encrypted under this key, the
  # final snapshot included, is unreadable once it is gone.
  deletion_window_in_days = var.disposable ? 7 : 30
  policy                  = data.aws_iam_policy_document.key.json
}

resource "aws_kms_alias" "this" {
  name          = "alias/${var.name}"
  target_key_id = aws_kms_key.this.key_id
}

resource "random_password" "jwt" {
  length  = 64
  special = false
}

# 32 random bytes each, base64: the shape env.schema.ts insists on.
resource "random_bytes" "key" {
  for_each = toset(["mfa", "webhooks", "sso"])
  length   = 32
}

resource "random_bytes" "inbound" {
  length = 24
}

resource "aws_secretsmanager_secret" "app" {
  name        = "${var.name}/app"
  description = "The API's signing and sealing keys"
  kms_key_id  = aws_kms_key.this.arn
  # These keys open every tenant's sealed secrets; a deleted one stays
  # recoverable for thirty days.
  recovery_window_in_days = var.disposable ? 0 : 30
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    JWT_SECRET             = random_password.jwt.result
    MFA_ENCRYPTION_KEY     = random_bytes.key["mfa"].base64
    WEBHOOK_SECRETS_KEY    = random_bytes.key["webhooks"].base64
    SSO_SECRETS_KEY        = random_bytes.key["sso"].base64
    INBOUND_WEBHOOK_SECRET = "whsec_${random_bytes.inbound.base64}"
  })
}

output "kms_key_arn" {
  value = aws_kms_key.this.arn
}

output "app_secret_arn" {
  value = aws_secretsmanager_secret.app.arn
}
