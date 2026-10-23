variable "name" {
  type = string
}

variable "kms_key_arn" {
  type = string
}

variable "data_subnet_ids" {
  type = list(string)
}

variable "database_security_group_id" {
  type = string
}

variable "cache_security_group_id" {
  type = string
}

variable "pooler_host" {
  description = "Where the application's pooled connections go: PgBouncer's service-discovery name."
  type        = string
}

variable "pooler_port" {
  type    = number
  default = 6432
}

variable "master_is_superuser" {
  description = <<-EOT
    Whether the engine's master user is a superuser. True on Floci, false on RDS
    (ADR-0059). When true, the provisioning job uses the master only for the
    instance step and makes a separate CREATEROLE-only admin, so everything
    after it runs with exactly the privileges RDS would give.
  EOT
  type        = bool
}

variable "instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "multi_az" {
  type    = bool
  default = false
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "backup_retention_days" {
  type    = number
  default = 7
}

variable "cache_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "cache_replicas" {
  description = "Read replicas beside the primary; one or more turns on automatic failover."
  type        = number
  default     = 0
}

variable "web_origins" {
  description = "Origins a browser may upload from and download to (CORS)."
  type        = list(string)
}
