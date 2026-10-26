# tflint for every root and module (CI: the infra job). The AWS ruleset checks
# names, instance classes and IAM against AWS's own data; the Terraform
# ruleset holds the language to its recommended style.
config {
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "aws" {
  enabled = true
  version = "0.50.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}
