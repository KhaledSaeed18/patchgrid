# One repository per image. Tags are immutable — a tag is a commit, and a
# deploy that names one gets exactly that build — and pushes are scanned.
# Third-party images the stack runs (PgBouncer) are mirrored here rather than
# pulled from Docker Hub at deploy time: one registry to trust, and no deploy
# that fails because someone else's rate limit did.

variable "name" {
  type = string
}

variable "repositories" {
  type = list(string)
}

variable "disposable" {
  description = "An environment thrown away whole (Floci): deletions are immediate and keep nothing. Off by default, which keeps everything."
  type        = bool
  default     = false
}

variable "kms_key_arn" {
  type = string
}

variable "keep_images" {
  description = "Tagged images kept per repository; older ones expire."
  type        = number
  default     = 20
}

resource "aws_ecr_repository" "this" {
  for_each             = toset(var.repositories)
  name                 = "${var.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  # A repository with images in it is never deleted by accident: they are
  # what a rollback deploys.
  force_delete = var.disposable

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Untagged layers left by a rebuilt tag"
        selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 1 }
        action       = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the last ${var.keep_images} builds"
        selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = var.keep_images }
        action       = { type = "expire" }
      },
    ]
  })
}

output "repository_urls" {
  value = { for key, repository in aws_ecr_repository.this : key => repository.repository_url }
}

output "repository_arns" {
  value = [for repository in aws_ecr_repository.this : repository.arn]
}
