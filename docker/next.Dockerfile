# syntax=docker/dockerfile:1
#
# apps/www and apps/app — one Dockerfile, the app picked by APP. Built from the
# repository root:
#
#   docker build -f docker/next.Dockerfile --build-arg APP=www -t patchgrid-www .
#   docker build -f docker/next.Dockerfile --build-arg APP=app -t patchgrid-app .
#
# Both read only NEXT_PUBLIC_* settings, and Next inlines those at build time:
# an image is built for one environment. The defaults are production's; a local
# image overrides them (scripts/aws.mjs shows how).

ARG NODE_IMAGE=node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH LEFTHOOK=0 CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS prune
ARG APP
RUN test -n "$APP" || (echo "build with --build-arg APP=www or APP=app" >&2; exit 1)
COPY . .
RUN pnpm dlx turbo@2.11.7 prune "@patchgrid/${APP}" --docker

FROM base AS build
ARG APP
ARG NEXT_PUBLIC_ROOT_DOMAIN=patchgrid.xyz
ARG NEXT_PUBLIC_PROTOCOL=https
ARG NEXT_PUBLIC_API_URL=https://api.patchgrid.xyz/api/v1
# Empty in production, where every origin is on 443.
ARG NEXT_PUBLIC_APP_PORT=""
ARG NEXT_PUBLIC_MARKETING_PORT=""
ENV NEXT_PUBLIC_ROOT_DOMAIN=${NEXT_PUBLIC_ROOT_DOMAIN} \
    NEXT_PUBLIC_PROTOCOL=${NEXT_PUBLIC_PROTOCOL} \
    NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_APP_PORT=${NEXT_PUBLIC_APP_PORT} \
    NEXT_PUBLIC_MARKETING_PORT=${NEXT_PUBLIC_MARKETING_PORT}
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ .
RUN pnpm --filter "@patchgrid/${APP}" run build

# The traced server and nothing else: no pnpm, no workspace, no install.
FROM ${NODE_IMAGE} AS runtime
ARG APP
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 APP=${APP}
WORKDIR /srv
COPY --from=build --chown=node:node /repo/apps/${APP}/.next/standalone/ ./
# The standalone server serves these only if they are beside it (see Next's `output` docs).
COPY --from=build --chown=node:node /repo/apps/${APP}/.next/static/ ./apps/${APP}/.next/static/
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
CMD ["sh", "-c", "exec node apps/${APP}/server.js"]
