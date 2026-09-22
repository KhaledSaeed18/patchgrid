# 0016 — Three deployables: `www`, `app`, `api`

- **Status:** Accepted
- **Date:** 2026-09-22

## Context

ADR-0014 fixes the hostnames. This records how the code is split and why the marketing site is a separate Next.js application rather than a route group inside the dashboard.

## Options considered

1. **One Next.js app, route groups `(marketing)` and `(app)`** — one deployable, shared components for free. But the two surfaces want opposite things: marketing wants static generation, aggressive CDN caching, SEO metadata, sitemaps and no auth; the dashboard wants per-request auth, tenant resolution and no public caching. Mixing them means one `proxy.ts` handling both, and one deploy that ships a marketing typo fix and an untested dashboard change together.
2. **Marketing on a separate stack** (Astro, a CMS, a site builder) — best raw SEO/performance, but a second toolchain and no shared design system, for a site with maybe eight pages.
3. **Two Next.js apps in the monorepo**, sharing `@patchgrid/ui` and `@patchgrid/contracts`.

## Decision

Option 3.

```
apps/
  www/    # patchgrid.xyz      — marketing. Mostly static/ISR, MDX docs + blog, SEO, signup entry
  app/    # <slug>.patchgrid.xyz — authenticated dashboard, fully dynamic, tenant-aware
  api/    # api.patchgrid.xyz  — NestJS, all business logic and data access
```

The existing shadcn scaffold at `apps/web` becomes `apps/app` (it already carries the theme provider and component wiring); `apps/www` is created fresh.

- Both frontends consume `@patchgrid/ui` (design tokens, primitives) so the marketing site and the product look like one product.
- `apps/www` may call exactly three API endpoints — signup, slug availability, contact — and nothing else. It never renders tenant data and never holds a session beyond reading the shared cookie to swap "Get started" for "Go to your workspace".
- `apps/app` is entirely dynamic: `dynamic = "force-dynamic"` semantics for tenant-scoped pages, no tenant data in the build output, no ISR.
- `apps/api` serves both, with CORS as described in ADR-0014.

## Consequences

- Three Dockerfiles, three CI build/test targets, three deployments later. Turborepo's task graph and remote-cacheable builds make this cheap.
- A design change in `@patchgrid/ui` rebuilds both frontends — intentional; that is the shared design system doing its job.
- Marketing content (pricing, docs, blog) is MDX in the repo, versioned with the code. No CMS in v1; adding one later only affects `apps/www`.
- The marketing site can be deployed, cached and rolled back independently of the product — which is the main practical win.
