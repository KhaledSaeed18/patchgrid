terraform {
  backend "s3" {
    key = "platform/terraform.tfstate"
  }
}
