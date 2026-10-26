# Plain HCL that Terraform also accepts: no OpenTofu-only feature is used, so
# the same code plans under either CLI (ADR-0058).
terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.70"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
  }
}
