# Where every task runs (ADR-0058): one cluster, a private namespace for
# service discovery, a log group per workload, and the IAM roles.
#
# Two kinds of role. The execution role is ECS's own, to pull the image, write
# the logs and read the secrets a task definition names; the application never
# holds it. Task roles are the application's, one per kind of workload, each
# with what that workload does and nothing more.

variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "secret_arns" {
  description = "Every secret a task definition may inject."
  type        = list(string)
}

variable "repository_arns" {
  description = "The ECR repositories tasks pull from."
  type        = list(string)
}

variable "files_bucket_arn" {
  type = string
}

variable "mail_identity_arn" {
  type = string
}

variable "log_groups" {
  description = "One per workload."
  type        = list(string)
}

variable "log_retention_days" {
  type    = number
  default = 30
}

resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enhanced"
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE"]
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# `pgbouncer.patchgrid.internal` and friends: names inside the VPC only.
resource "aws_service_discovery_private_dns_namespace" "this" {
  name = "${replace(var.name, "-", ".")}.internal"
  vpc  = var.vpc_id
}

resource "aws_cloudwatch_log_group" "this" {
  for_each          = toset(var.log_groups)
  name              = "/${var.name}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn
}

data "aws_iam_policy_document" "assume_ecs_tasks" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# ─── The execution role: ECS pulling, logging and injecting ──────────────────

resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_tasks.json
}

data "aws_iam_policy_document" "execution" {
  # The token is account-wide by AWS's design; the layers are this product's.
  statement {
    sid       = "RegistryToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid       = "PullImages"
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
    resources = var.repository_arns
  }
  statement {
    sid       = "WriteLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [for group in aws_cloudwatch_log_group.this : "${group.arn}:*"]
  }
  statement {
    sid       = "InjectSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = var.secret_arns
  }
  statement {
    sid       = "DecryptSecrets"
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "execution"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

# ─── Task roles: what the application itself may do ──────────────────────────

# api, worker and jobs: the files bucket (objects only, under the key), and
# sending mail as the product's identity.
data "aws_iam_policy_document" "backend" {
  statement {
    sid       = "Files"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
    resources = ["${var.files_bucket_arn}/*"]
  }
  statement {
    sid       = "FilesBucket"
    actions   = ["s3:ListBucket"]
    resources = [var.files_bucket_arn]
  }
  statement {
    sid       = "FilesKey"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.kms_key_arn]
  }
  statement {
    sid       = "SendMail"
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = [var.mail_identity_arn]
  }
}

resource "aws_iam_role" "backend" {
  name               = "${var.name}-backend"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_tasks.json
}

resource "aws_iam_role_policy" "backend" {
  name   = "backend"
  role   = aws_iam_role.backend.id
  policy = data.aws_iam_policy_document.backend.json
}

# app, www and the pooler call nothing in AWS. A role with no policy says so.
resource "aws_iam_role" "none" {
  name               = "${var.name}-no-aws-access"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_tasks.json
}

output "cluster" {
  value = {
    arn  = aws_ecs_cluster.this.arn
    name = aws_ecs_cluster.this.name
  }
}

output "namespace" {
  value = {
    id   = aws_service_discovery_private_dns_namespace.this.id
    name = aws_service_discovery_private_dns_namespace.this.name
  }
}

output "execution_role_arn" {
  value = aws_iam_role.execution.arn
}

output "task_role_arns" {
  value = {
    backend = aws_iam_role.backend.arn
    none    = aws_iam_role.none.arn
  }
}

output "log_groups" {
  value = { for key, group in aws_cloudwatch_log_group.this : key => group.name }
}
