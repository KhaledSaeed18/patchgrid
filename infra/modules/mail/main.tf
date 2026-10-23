# Outbound mail (ADR-0027, DNS.md §4): an SES domain identity with Easy DKIM,
# its three CNAMEs, SPF and a DMARC policy at p=none while alignment is
# watched. SES verifies the domain once the CNAMEs resolve, on AWS and on Floci
# alike.
#
# The identity is SES's classic resource, not `aws_sesv2_email_identity`: Floci
# returns a v2 identity ARN without the account and then refuses that ARN when
# the provider lists its tags. Both APIs manage the same identity, and the
# application sends through v2 either way (runbook, "Where Floci differs").

variable "domain" {
  type = string
}

variable "public_zone_id" {
  type = string
}

variable "dmarc_report_address" {
  type = string
}

resource "aws_ses_domain_identity" "this" {
  domain = var.domain
}

resource "aws_ses_domain_dkim" "this" {
  domain = aws_ses_domain_identity.this.domain
}

resource "aws_route53_record" "dkim" {
  count   = 3
  zone_id = var.public_zone_id
  name    = "${aws_ses_domain_dkim.this.dkim_tokens[count.index]}._domainkey.${var.domain}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${aws_ses_domain_dkim.this.dkim_tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_route53_record" "spf" {
  zone_id = var.public_zone_id
  name    = var.domain
  type    = "TXT"
  ttl     = 3600
  records = ["v=spf1 include:amazonses.com -all"]
}

resource "aws_route53_record" "dmarc" {
  zone_id = var.public_zone_id
  name    = "_dmarc.${var.domain}"
  type    = "TXT"
  ttl     = 3600
  records = ["v=DMARC1; p=none; rua=mailto:${var.dmarc_report_address}; pct=100"]
}

output "identity_arn" {
  value = aws_ses_domain_identity.this.arn
}
