# Attachments and exports, in one bucket keyed `org/<orgId>/…`, with uploads
# landing under `staging/` first (ADR-0005, ADR-0038).
#
# Versioning stays OFF on purpose: erasure and the org purge (ADR-0043,
# ADR-0044) promise that a deleted file is gone, and a version history would
# quietly keep every one of them.

resource "aws_s3_bucket" "files" {
  bucket = "${var.name}-files"
}

resource "aws_s3_bucket_ownership_controls" "files" {
  bucket = aws_s3_bucket.files.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "files" {
  bucket                  = aws_s3_bucket.files.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "files" {
  bucket = aws_s3_bucket.files.id

  # An upload the browser never completed (ADR-0038); MinIO's rule, in S3's terms.
  rule {
    id     = "staging"
    status = "Enabled"
    filter {
      prefix = "staging/"
    }
    expiration {
      days = 1
    }
  }

  rule {
    id     = "incomplete-multipart"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# The browser PUTs straight to a presigned URL and GETs straight from one;
# the API never relays the bytes (ADR-0005).
resource "aws_s3_bucket_cors_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  cors_rule {
    allowed_origins = var.web_origins
    allowed_methods = ["GET", "HEAD", "PUT"]
    allowed_headers = ["content-type"]
    expose_headers  = ["etag"]
    max_age_seconds = 600
  }
}

# Nothing but TLS reaches the bucket.
data "aws_iam_policy_document" "files" {
  statement {
    sid     = "TlsOnly"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.files.arn,
      "${aws_s3_bucket.files.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "files" {
  bucket     = aws_s3_bucket.files.id
  policy     = data.aws_iam_policy_document.files.json
  depends_on = [aws_s3_bucket_public_access_block.files]
}
