# PgBouncer, mirrored into the environment's registry (ADR-0058), verifying the
# database's certificate against the environment's CA (on AWS: the RDS bundle),
# and serving its clients TLS with the certificate the task is handed.
#
#   docker build -f infra/images/pgbouncer.Dockerfile --build-context images=infra/images infra/.floci
FROM edoburu/pgbouncer:v1.26.1-p0@sha256:488422e38cff912895d0d65d8963fcd306e6ac589a724398b6eb8e294e94d624
COPY --chmod=0444 ca.pem /etc/pgbouncer/ca.pem
COPY --from=images --chmod=0555 pgbouncer-tls.sh /usr/local/bin/pgbouncer-tls.sh
ENV SERVER_TLS_CA_FILE=/etc/pgbouncer/ca.pem \
    SERVER_TLS_SSLMODE=verify-full
ENTRYPOINT ["/usr/local/bin/pgbouncer-tls.sh"]
CMD ["/usr/bin/pgbouncer", "/etc/pgbouncer/pgbouncer.ini"]
