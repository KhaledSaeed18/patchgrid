# Off only while the browser suite runs (`pnpm aws:e2e`), as it is in CI's
# development-stack job: the suite drives the stack far past any one person's
# pace, and Floci's load balancer sends no X-Forwarded-For, so every browser
# and every server-side call shares one address and one per-IP budget.
variable "throttle_enabled" {
  description = "The API's rate limits; true everywhere but a browser suite run"
  type        = bool
  default     = true
}
