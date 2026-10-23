# The way in (ARCHITECTURE.md §Deployment, ADR-0058): one certificate for the
# apex and every subdomain, one load balancer, routing by host.
#
#   patchgrid.test                         → www
#   api.patchgrid.test                     → api
#   app. / admin. / <slug>.patchgrid.test  → app
#
# DNS is split-horizon. The public zone carries what the internet must see —
# the certificate's validation, and the mail records — and the private zone
# points the same names at the load balancer from inside the VPC, which is
# how the Next servers reach the API at the URL the browser uses (ADR-0007).

resource "aws_route53_zone" "public" {
  name    = var.root_domain
  comment = "${var.name}: certificate validation and mail"
}

resource "aws_route53_zone" "private" {
  name    = var.root_domain
  comment = "${var.name}: the product's hosts, from inside the VPC"
  vpc {
    vpc_id = var.vpc_id
  }
}

# A wildcard, not a certificate per tenant: it publishes nothing about who the
# customers are (DNS.md §3).
resource "aws_acm_certificate" "this" {
  domain_name               = var.root_domain
  subject_alternative_names = ["*.${var.root_domain}"]
  validation_method         = "DNS"
  key_algorithm             = "EC_prime256v1" # gitleaks:allow (an algorithm name, not a key)

  lifecycle {
    create_before_destroy = true
  }
}

# Keyed by domain, which is known at plan time; the apex and the wildcard share
# one validation record, so the second write overwrites the first with itself.
resource "aws_route53_record" "validation" {
  for_each = {
    for option in aws_acm_certificate.this.domain_validation_options : option.domain_name => option
  }
  zone_id         = aws_route53_zone.public.zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "this" {
  certificate_arn         = aws_acm_certificate.this.arn
  validation_record_fqdns = [for record in aws_route53_record.validation : record.fqdn]
}

resource "aws_lb" "this" {
  name               = var.name
  load_balancer_type = "application"
  internal           = false
  subnets            = var.public_subnet_ids
  security_groups    = [var.alb_security_group_id]

  # Tenant routing reads the workspace from the host the browser used.
  preserve_host_header       = true
  drop_invalid_header_fields = true
  xff_header_processing_mode = "append"
  # The notification stream (ADR-0008) beats every 25 s; a minute of quiet is
  # a dead client, not a slow one.
  idle_timeout               = 75
  enable_deletion_protection = var.deletion_protection
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.this.certificate_arn

  # A host the rules do not name is nobody's.
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
}

locals {
  targets = {
    # Readiness, not liveness: a task that cannot reach the database is taken
    # out of rotation, and left running.
    api = { port = 4000, health = "/health/ready", matcher = "200" }
    app = { port = 3000, health = "/api/health", matcher = "200" }
    www = { port = 3000, health = "/api/health", matcher = "200" }
  }
  # Most specific first: the API's host, the apex, then every other subdomain.
  rules = {
    api = { priority = 10, hosts = ["api.${var.root_domain}"] }
    www = { priority = 20, hosts = [var.root_domain] }
    app = { priority = 30, hosts = ["*.${var.root_domain}"] }
  }
}

resource "aws_lb_target_group" "this" {
  for_each    = local.targets
  name        = "${var.name}-${each.key}"
  port        = each.value.port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  # In-flight requests finish before a draining task is stopped; ECS's own
  # stop timeout is longer than this.
  deregistration_delay = 30

  health_check {
    path                = each.value.health
    matcher             = each.value.matcher
    interval            = 10
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener_rule" "this" {
  for_each     = local.rules
  listener_arn = aws_lb_listener.https.arn
  priority     = each.value.priority

  condition {
    host_header {
      values = each.value.hosts
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this[each.key].arn
  }
}

resource "aws_route53_record" "private" {
  for_each = toset([var.root_domain, "*.${var.root_domain}"])
  zone_id  = aws_route53_zone.private.zone_id
  name     = each.key
  type     = "A"
  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = false
  }
}
