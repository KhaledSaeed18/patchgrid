output "target_group_arns" {
  value = { for key, group in aws_lb_target_group.this : key => group.arn }
}

output "load_balancer" {
  value = {
    arn      = aws_lb.this.arn
    dns_name = aws_lb.this.dns_name
  }
}

output "https_listener_arn" {
  value = aws_lb_listener.https.arn
}

output "public_zone_id" {
  value = aws_route53_zone.public.zone_id
}

output "private_zone_id" {
  value = aws_route53_zone.private.zone_id
}
