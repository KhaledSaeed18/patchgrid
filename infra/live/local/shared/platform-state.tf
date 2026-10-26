# The platform root's outputs, for the roots built on it. Symlinked into jobs
# and services; same backend settings as ../backend.hcl.
data "terraform_remote_state" "platform" {
  backend = "s3"
  config = {
    bucket                      = "patchgrid-local-tfstate"
    key                         = "platform/terraform.tfstate"
    region                      = "us-east-1"
    use_path_style              = true
    access_key                  = "test"
    secret_key                  = "test"
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    endpoints                   = { s3 = "http://localhost:4566" }
  }
}

locals {
  platform = data.terraform_remote_state.platform.outputs
}

variable "image_tag" {
  description = "The build every task runs: a commit, pushed to every repository under the same tag."
  type        = string
}

variable "cpu_architecture" {
  description = "What the images were built for. `pnpm aws:deploy` passes the build machine's."
  type        = string
  default     = "ARM64"
}
