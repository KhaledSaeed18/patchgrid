# PgBouncer, mirrored into the environment's registry (ADR-0058), verifying the
# database's certificate against the environment's CA (on AWS: the RDS bundle).
#
#   docker build -f infra/images/pgbouncer.Dockerfile infra/.floci
FROM edoburu/pgbouncer:v1.26.1-p0@sha256:488422e38cff912895d0d65d8963fcd306e6ac589a724398b6eb8e294e94d624
COPY --chmod=0444 ca.pem /etc/pgbouncer/ca.pem
ENV SERVER_TLS_CA_FILE=/etc/pgbouncer/ca.pem \
    SERVER_TLS_SSLMODE=verify-full
