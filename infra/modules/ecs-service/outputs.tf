output "task_definition_arn" {
  value = aws_ecs_task_definition.this.arn
}

output "family" {
  value = aws_ecs_task_definition.this.family
}

output "service_name" {
  value = var.service == null ? null : aws_ecs_service.this[0].name
}
