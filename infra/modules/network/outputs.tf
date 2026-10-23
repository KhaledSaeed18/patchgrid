output "vpc_id" {
  value = aws_vpc.this.id
}

output "public_subnet_ids" {
  value = [for zone in var.availability_zones : aws_subnet.public[zone].id]
}

output "app_subnet_ids" {
  value = [for zone in var.availability_zones : aws_subnet.app[zone].id]
}

output "data_subnet_ids" {
  value = [for zone in var.availability_zones : aws_subnet.data[zone].id]
}

output "security_groups" {
  description = "One per role: alb, web, api, jobs, pooler, database, cache."
  value = {
    alb      = aws_security_group.alb.id
    web      = aws_security_group.web.id
    api      = aws_security_group.api.id
    jobs     = aws_security_group.jobs.id
    pooler   = aws_security_group.pooler.id
    database = aws_security_group.database.id
    cache    = aws_security_group.cache.id
  }
}
