# 0010 — LLM and phishing model as swappable, non-blocking services inside the monorepo

- **Status:** Accepted
- **Date:** 2026-09-22

## Context

Two differentiators depend on models that do not run inside Node: ticket triage via Ollama (an HTTP server) and URL phishing scoring via a Python model from the MS thesis (scikit-learn/PyTorch stack). Both are later milestones, but the boundaries must be decided early so the core is built to accommodate them.

## Options considered

**Phishing model location**
1. Separate git repository, deployed independently — decoupled; splits the portfolio story and complicates local setup.
2. **`apps/phishing-svc` in this monorepo** — a small FastAPI app with its own Dockerfile and `requirements.txt`, ignored by Turborepo's TS tasks, started by Docker Compose. One repo, one `docker compose up`, one README.
3. Port the model to ONNX and run it in Node — possible for the classifier, but the thesis feature-extraction pipeline is Python; porting it is a project of its own.

**Coupling to ticket creation**
1. Call the model synchronously during create — a slow or down model would slow or break ticket creation.
2. **Commit the ticket, then enqueue a `triage` job** that calls the model and writes results to `TicketTriage` / `PhishingReport`. The UI shows "analysing…" until results arrive via SSE.

## Decision

`apps/phishing-svc` in the monorepo (option 2); Ollama as a Docker Compose service. Both are reached only through Nest injection tokens — `TicketClassifier`, `UrlRiskScorer`, `EmbeddingProvider` — each with a real HTTP implementation and a `Noop`/`Fake` one selected by env. Triage is always asynchronous and best-effort; tickets are never blocked by it. Timeouts: 20 s LLM, 5 s phishing, 5 s embeddings, then log and move on. The LLM produces suggested impact/urgency, never a priority, so the matrix remains the only source of priority.

## Consequences

- The core milestones M0–M6 compile and run with the `Noop` implementations; nothing model-related is required to demo the ITSM lifecycle.
- The phishing service exposes `POST /score { url } → { riskScore, verdict, modelVersion }` and `GET /health`; its contract is documented in `apps/phishing-svc/README.md` when built.
- Model results are stored with `model` / `modelVersion` so the UI and any evaluation can tell which model produced what.
- Deployment of Ollama for a public demo (server vs degraded mode) is deferred to M8 and will be its own ADR.
