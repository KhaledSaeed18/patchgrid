# A production image, trusting the environment's private CA (ADR-0058).
#
# On AWS, ACM's certificates chain to public roots and nothing is added. Here
# they chain to Floci's CA, as an organisation's would to its own private CA,
# and the bundle is baked in the way such organisations do: one layer over the
# unchanged production image, built per environment, never committed.
#
#   docker build -f infra/images/private-ca.Dockerfile --build-arg BASE=<image> infra/.floci
ARG BASE
FROM ${BASE}
COPY --chmod=0444 ca.pem /etc/ssl/certs/patchgrid-private-ca.pem
# Node's TLS (fetch, pg, the AWS SDK) adds it to its built-in roots.
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/patchgrid-private-ca.pem
