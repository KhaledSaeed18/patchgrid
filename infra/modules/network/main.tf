# Three tiers per availability zone (ARCHITECTURE.md §Deployment):
#
#   public   the load balancer, and the NAT gateway
#   app      ECS tasks: api, worker, app, www, pgbouncer, one-off jobs
#   data     RDS and ElastiCache, which nothing outside the VPC can route to
#
# Security groups are per role, and each admits only the roles that call it,
# by group rather than by address, so a task's address never matters.

locals {
  zones = { for index, zone in var.availability_zones : zone => index }
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = var.name }
}

resource "aws_subnet" "public" {
  for_each                = local.zones
  vpc_id                  = aws_vpc.this.id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(var.cidr, 4, each.value)
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name}-public-${each.key}", tier = "public" }
}

resource "aws_subnet" "app" {
  for_each          = local.zones
  vpc_id            = aws_vpc.this.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.cidr, 4, 4 + each.value)
  tags              = { Name = "${var.name}-app-${each.key}", tier = "app" }
}

resource "aws_subnet" "data" {
  for_each          = local.zones
  vpc_id            = aws_vpc.this.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.cidr, 4, 8 + each.value)
  tags              = { Name = "${var.name}-data-${each.key}", tier = "data" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  for_each       = aws_subnet.public
  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  count  = var.nat_gateway ? 1 : 0
  domain = "vpc"
  tags   = { Name = "${var.name}-nat" }
}

resource "aws_nat_gateway" "this" {
  count         = var.nat_gateway ? 1 : 0
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[var.availability_zones[0]].id
  tags          = { Name = var.name }
  depends_on    = [aws_internet_gateway.this]
}

# The app tier leaves through the NAT; the data tier has no route out at all.
resource "aws_route_table" "app" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-app" }
}

resource "aws_route" "app_egress" {
  count                  = var.nat_gateway ? 1 : 0
  route_table_id         = aws_route_table.app.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[0].id
}

resource "aws_route_table_association" "app" {
  for_each       = aws_subnet.app
  subnet_id      = each.value.id
  route_table_id = aws_route_table.app.id
}

resource "aws_route_table" "data" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-data" }
}

resource "aws_route_table_association" "data" {
  for_each       = aws_subnet.data
  subnet_id      = each.value.id
  route_table_id = aws_route_table.data.id
}

# ─── Security groups, one per role ───────────────────────────────────────────

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "The load balancer: HTTP and HTTPS from anywhere"
  vpc_id      = aws_vpc.this.id
}

resource "aws_security_group" "web" {
  name        = "${var.name}-web"
  description = "app and www: the frontends, from the load balancer"
  vpc_id      = aws_vpc.this.id
}

resource "aws_security_group" "api" {
  name        = "${var.name}-api"
  description = "api and worker: from the load balancer"
  vpc_id      = aws_vpc.this.id
}

resource "aws_security_group" "jobs" {
  name        = "${var.name}-jobs"
  description = "One-off tasks: provisioning, migrations, the seed, verification"
  vpc_id      = aws_vpc.this.id
}

resource "aws_security_group" "pooler" {
  name        = "${var.name}-pooler"
  description = "PgBouncer: from api, worker and jobs"
  vpc_id      = aws_vpc.this.id
}

resource "aws_security_group" "database" {
  name        = "${var.name}-database"
  description = "RDS: from the pooler, jobs, and the api's LISTEN connection"
  vpc_id      = aws_vpc.this.id
}

resource "aws_security_group" "cache" {
  name        = "${var.name}-cache"
  description = "ElastiCache: from api, worker and jobs"
  vpc_id      = aws_vpc.this.id
}

locals {
  ingress = {
    alb_http       = { group = aws_security_group.alb.id, port = 80, cidr = "0.0.0.0/0", from = null }
    alb_https      = { group = aws_security_group.alb.id, port = 443, cidr = "0.0.0.0/0", from = null }
    web_from_alb   = { group = aws_security_group.web.id, port = 3000, cidr = null, from = aws_security_group.alb.id }
    api_from_alb   = { group = aws_security_group.api.id, port = 4000, cidr = null, from = aws_security_group.alb.id }
    pooler_api     = { group = aws_security_group.pooler.id, port = 6432, cidr = null, from = aws_security_group.api.id }
    pooler_jobs    = { group = aws_security_group.pooler.id, port = 6432, cidr = null, from = aws_security_group.jobs.id }
    db_from_pooler = { group = aws_security_group.database.id, port = 5432, cidr = null, from = aws_security_group.pooler.id }
    db_from_jobs   = { group = aws_security_group.database.id, port = 5432, cidr = null, from = aws_security_group.jobs.id }
    # The outbox wake's LISTEN is session-scoped, so it bypasses the pooler (ADR-0049).
    db_from_api = { group = aws_security_group.database.id, port = 5432, cidr = null, from = aws_security_group.api.id }
    cache_api   = { group = aws_security_group.cache.id, port = 6379, cidr = null, from = aws_security_group.api.id }
    cache_jobs  = { group = aws_security_group.cache.id, port = 6379, cidr = null, from = aws_security_group.jobs.id }
  }
}

# The classic rule resource, not `aws_vpc_security_group_ingress_rule`: Floci
# reports a referenced group as `<account>/sg-…`, AWS's cross-account form, and
# the newer resource then plans a change on every run. Both write the same rule.
resource "aws_security_group_rule" "ingress" {
  for_each                 = local.ingress
  type                     = "ingress"
  security_group_id        = each.value.group
  protocol                 = "tcp"
  from_port                = each.value.port
  to_port                  = each.value.port
  cidr_blocks              = each.value.cidr == null ? null : [each.value.cidr]
  source_security_group_id = each.value.from
  description              = each.key
}

# Egress stays open for every role: tasks reach ECR, Secrets Manager, SES and
# webhook receivers, and the API's own SSRF guard decides what a webhook may
# reach (ADR-0050), not the network.
resource "aws_vpc_security_group_egress_rule" "all" {
  for_each = {
    alb  = aws_security_group.alb.id, web = aws_security_group.web.id, api = aws_security_group.api.id,
    jobs = aws_security_group.jobs.id, pooler = aws_security_group.pooler.id,
  }
  security_group_id = each.value
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
  description       = "egress"
}
