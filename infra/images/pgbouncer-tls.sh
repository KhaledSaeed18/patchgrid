#!/bin/sh
# Writes the client-side certificate the task was handed (TLS_KEY, TLS_CERT,
# from Secrets Manager) to files PgBouncer can read, then starts it as the
# image would. Without them PgBouncer starts as before.
set -eu
if [ -n "${TLS_KEY:-}" ] && [ -n "${TLS_CERT:-}" ]; then
  umask 077
  printf '%s\n' "$TLS_KEY" > /tmp/client-tls.key
  printf '%s\n' "$TLS_CERT" > /tmp/client-tls.crt
  export CLIENT_TLS_KEY_FILE=/tmp/client-tls.key CLIENT_TLS_CERT_FILE=/tmp/client-tls.crt
fi
unset TLS_KEY TLS_CERT
exec /entrypoint.sh "$@"
