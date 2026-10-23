variable "name" {
  description = "Prefix for every resource, such as patchgrid-local."
  type        = string
}

variable "cidr" {
  description = "The VPC's range. Each tier gets one /20 per availability zone from it."
  type        = string
  default     = "10.40.0.0/16"
}

variable "availability_zones" {
  description = "Two at least: an ALB needs subnets in two zones."
  type        = list(string)
  validation {
    condition     = length(var.availability_zones) >= 2
    error_message = "An application load balancer needs subnets in at least two availability zones."
  }
}

variable "nat_gateway" {
  description = "Give the private subnets a NAT gateway for egress (image pulls, SES, webhooks). One, not one per zone: a rehearsal does not pay for zonal redundancy."
  type        = bool
  default     = true
}
