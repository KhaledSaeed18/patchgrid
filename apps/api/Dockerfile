# syntax=docker/dockerfile:1
#
# apps/api — the NestJS API and its workers (one image; WORKER_MODE picks the half).
# Built from the repository root:
#
#   docker build -f apps/api/Dockerfile -t patchgrid-api .
#   docker build -f apps/api/Dockerfile --target tools -t patchgrid-tools .
#
# The workspace packages are consumed as TypeScript source and Node 24 strips
# their types at load. It will not do that under node_modules, so the runtime
# keeps the pruned workspace's own layout — packages/* as directories, linked
# into node_modules — rather than a `pnpm deploy` bundle, which would copy them
# in and fail at the first import.

ARG NODE_IMAGE=node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH LEFTHOOK=0 CI=true
RUN corepack enable
WORKDIR /repo

# Only what @patchgrid/api depends on, split so the install layer is cached on
# the lockfile alone.
FROM base AS prune
COPY . .
RUN pnpm dlx turbo@2.11.7 prune @patchgrid/api --docker

# The whole toolchain: generate the Prisma client, compile the API. Also the
# `tools` image — migrations, the seed, operator grants — which needs the CLI
# and tsx that the runtime does not.
FROM base AS build
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ .
RUN pnpm --filter @patchgrid/database run generate \
 && pnpm --filter @patchgrid/api run build

FROM build AS tools
ENV NODE_ENV=production PRISMA_HIDE_UPDATE_MESSAGE=1
WORKDIR /repo/packages/database
# `docker compose run --rm tools pnpm run migrate:deploy` and friends.
CMD ["pnpm", "run", "migrate:deploy"]

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod \
 # @prisma/client's optional peers — the Prisma CLI, which brings Studio, an
 # embedded Postgres, effect and Prettier, and TypeScript — come in with the
 # production install because the lockfile resolves them for the build. The
 # runtime needs none of them: the client is generated at build time and runs
 # on the pg adapter. Over 200 MB of the image (HANDOFF, M13).
 && cd node_modules/.pnpm \
 && rm -rf prisma@* @prisma+studio-core@* @prisma+dev@* @prisma+engines@* @electric-sql+pglite@* \
           effect@* prettier@* typescript@*
# What dist requires at runtime: the packages' sources and the generated
# client. Only those — the build stage's node_modules would overwrite the
# production install's.
COPY --from=build /repo/packages/contracts/src/ packages/contracts/src/
COPY --from=build /repo/packages/database/src/ packages/database/src/
COPY --from=build /repo/packages/database/generated/ packages/database/generated/
COPY --from=build /repo/apps/api/dist/ apps/api/dist/
USER node
WORKDIR /repo/apps/api
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# main.js starts telemetry before it requires the application (ADR-0046): run
# it directly, never through a wrapper that loads the app first.
CMD ["node", "dist/main.js"]
