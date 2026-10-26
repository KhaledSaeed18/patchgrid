variable "name" {
  description = "The workload: api, worker, app, www, pgbouncer, or a job such as migrate."
  type        = string
}

variable "family_prefix" {
  type = string
}

variable "cluster_arn" {
  type = string
}

variable "image" {
  type = string
}

variable "cpu" {
  type    = number
  default = 256
}

variable "memory" {
  type    = number
  default = 512
}

variable "command" {
  type    = list(string)
  default = null
}

variable "environment" {
  description = "Plain settings. Anything secret goes in `secrets`."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Variable name → `<secret arn>:<json key>::`, injected by ECS at start (the execution role reads them, the task never calls Secrets Manager)."
  type        = map(string)
  default     = {}
}

variable "port" {
  description = "The container port it serves on, if it serves."
  type        = number
  default     = null
}

variable "health_check" {
  description = "A container health check command, for ECS to replace a wedged task."
  type        = list(string)
  default     = null
}

variable "execution_role_arn" {
  type = string
}

variable "task_role_arn" {
  type = string
}

variable "log_group" {
  type = string
}

variable "region" {
  type = string
}

variable "stop_timeout" {
  description = "Seconds between SIGTERM and SIGKILL. The worker needs long enough to finish a job (BullMQ's graceful close)."
  type        = number
  default     = 30
}

variable "service" {
  description = "Run it as a service. Null for a one-off job: the task definition only, started with RunTask."
  type = object({
    desired_count          = number
    subnet_ids             = list(string)
    security_group_id      = string
    target_group_arn       = optional(string)
    discovery_namespace_id = optional(string)
    grace_period_seconds   = optional(number, 60)
  })
  default = null
}

variable "cpu_architecture" {
  description = "ARM64 (Graviton, cheaper per vCPU) or X86_64: whatever the images were built for."
  type        = string
  default     = "ARM64"
  validation {
    condition     = contains(["ARM64", "X86_64"], var.cpu_architecture)
    error_message = "ARM64 or X86_64."
  }
}
