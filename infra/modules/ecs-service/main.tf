# One workload: a task definition, and a service unless it is a one-off job.
# Fargate-shaped (awsvpc, its own ENI and security group), deployed rolling
# with the circuit breaker on, so a release whose tasks never turn healthy is
# rolled back rather than left half-replaced.

locals {
  family = "${var.family_prefix}-${var.name}"
}

resource "aws_ecs_task_definition" "this" {
  family                   = local.family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([
    merge(
      {
        name        = var.name
        image       = var.image
        essential   = true
        stopTimeout = var.stop_timeout
        environment = [for key in sort(keys(var.environment)) : { name = key, value = var.environment[key] }]
        secrets     = [for key in sort(keys(var.secrets)) : { name = key, valueFrom = var.secrets[key] }]
        logConfiguration = {
          logDriver = "awslogs"
          options = {
            awslogs-group         = var.log_group
            awslogs-region        = var.region
            awslogs-stream-prefix = var.name
          }
        }
      },
      var.command == null ? {} : { command = var.command },
      var.port == null ? {} : { portMappings = [{ containerPort = var.port, protocol = "tcp", name = var.name }] },
      var.health_check == null ? {} : {
        healthCheck = { command = var.health_check, interval = 15, timeout = 5, retries = 3, startPeriod = 30 }
      },
    )
  ])
}

resource "aws_service_discovery_service" "this" {
  count = try(var.service.discovery_namespace_id, null) == null ? 0 : 1
  name  = var.name

  dns_config {
    namespace_id   = var.service.discovery_namespace_id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
}

resource "aws_ecs_service" "this" {
  count           = var.service == null ? 0 : 1
  name            = var.name
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.service.desired_count
  launch_type     = "FARGATE"

  # Replacements start before the old tasks drain.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  health_check_grace_period_seconds = try(var.service.target_group_arn, null) == null ? null : var.service.grace_period_seconds
  wait_for_steady_state             = true

  network_configuration {
    subnets          = var.service.subnet_ids
    security_groups  = [var.service.security_group_id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = try(var.service.target_group_arn, null) == null ? [] : [var.service.target_group_arn]
    content {
      target_group_arn = load_balancer.value
      container_name   = var.name
      container_port   = var.port
    }
  }

  dynamic "service_registries" {
    for_each = aws_service_discovery_service.this
    content {
      registry_arn = service_registries.value.arn
    }
  }
}
