# The AWS provider against Floci (ADR-0058). Symlinked into every root under
# live/local, so the endpoints are written once. Nothing in ../../modules knows
# it is emulated: a real environment is a copy of this directory with this file
# reduced to `region`, and its backend pointed at a real bucket.
provider "aws" {
  region = var.region

  # Floci accepts any non-empty credentials. Real environments take them from
  # the default chain instead, and never from a file.
  access_key = "test"
  secret_key = "test"

  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true

  endpoints {
    acm              = local.floci_endpoint
    cloudwatch       = local.floci_endpoint
    dynamodb         = local.floci_endpoint
    ec2              = local.floci_endpoint
    ecr              = local.floci_endpoint
    ecs              = local.floci_endpoint
    elasticache      = local.floci_endpoint
    elbv2            = local.floci_endpoint
    iam              = local.floci_endpoint
    kms              = local.floci_endpoint
    logs             = local.floci_endpoint
    rds              = local.floci_endpoint
    route53          = local.floci_endpoint
    s3               = local.floci_endpoint
    secretsmanager   = local.floci_endpoint
    servicediscovery = local.floci_endpoint
    ses              = local.floci_endpoint
    sesv2            = local.floci_endpoint
    ssm              = local.floci_endpoint
    sts              = local.floci_endpoint
  }

  default_tags {
    tags = {
      project     = "patchgrid"
      environment = "local"
      managed-by  = "opentofu"
    }
  }
}

locals {
  floci_endpoint = "http://localhost:4566"
}

variable "region" {
  description = "The emulated region. Floci serves every region; one is used throughout."
  type        = string
  default     = "us-east-1"
}
