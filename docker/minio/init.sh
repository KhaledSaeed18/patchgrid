#!/bin/sh
# One-shot bucket setup. The browser PUTs directly to storage with a presigned
# URL (ADR-0005), so the bucket must exist and must never be public.
#
# CORS is NOT set here: MinIO implements it as a server setting
# (MINIO_API_CORS_ALLOW_ORIGIN, see docker-compose.yml), not per bucket —
# `mc cors set` reports "functionality that is not implemented".
set -eu

mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing "local/${S3_BUCKET}"

# Never public. Downloads are presigned GETs issued only after the RBAC check.
mc anonymous set none "local/${S3_BUCKET}"

echo "[patchgrid] bucket ${S3_BUCKET} ready"
