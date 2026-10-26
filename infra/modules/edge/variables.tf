variable "name" {
  type = string
}

variable "root_domain" {
  description = "The product's domain: www at the apex, the API at api., workspaces at <slug>."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "alb_security_group_id" {
  type = string
}

variable "deletion_protection" {
  type    = bool
  default = true
}
