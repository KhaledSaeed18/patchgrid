# 0056 — M7 is dropped: no models, no automation rule engine

- **Status:** Accepted
- **Date:** 2026-10-23
- **Supersedes:** [0010](0010-ml-services-behind-interfaces-in-monorepo.md)
- **Amends:** [0048](0048-roadmap-after-m10.md) (build order), `FEATURES.md`

## Context

M7, "Differentiators", was the one milestone that needed local models: LLM triage through Ollama, a
phishing URL scorer in a Python service, embeddings in pgvector for duplicate detection, and, bundled
with them, an automation rule engine. Twice it moved to the end of the build order (ADR-0048) so
everything else could be built first. Nothing built since depends on it. The only signs it existed in
the running system were placeholders: an `AUTOMATION_RULES` plan limit with nothing to count, the
`automation:read`/`automation:write` permissions guarding no route, an `AUTOMATION` comment author no
code writes, and the pgvector extension, installed and unused.

The project's owner has decided Patchgrid does not need machine learning or local models. What the
project is meant to teach is multi-tenant isolation, authorization and reliable delivery, and M8–M14
cover that. A model, a Python service and a vector index would add a second language, a GPU-sized
container and an attack surface (TB8, prompt injection) without adding much to that.

The automation rule engine is not ML, but it was only in M7 and it is not in M14. Rules that act on
tickets would need a design of their own: a condition language, loop protection, an actor, audit. That
design would be a new milestone, decided as one, not something left over from M7.

## Decision

M7 is removed from the plan, entirely:

- **No models.** No Ollama, no `apps/phishing-svc`, no `TicketClassifier`, `EmbeddingProvider` or
  `UrlRiskScorer` ports, no `TicketTriage`, `TicketEmbedding` or `PhishingReport` tables. Phishing
  stays an ordinary category (Security → Phishing) that routes by `defaultTeamId`.
- **No automation rule engine.** Escalation is the hard-coded rule in `DOMAIN.md` §4.3. The
  `automation:*` permissions, the `AUTOMATION_RULES` metric and the `AUTOMATION` comment author are
  removed, with a migration that recreates both enums without the value.
- **No pgvector.** Postgres is the stock `postgres:17-bookworm` image, the same Debian release the
  pgvector image was built on, so an existing volume keeps its collation version. The bootstrap drops
  the extension where an older bootstrap installed it.
- The build order is **M0–M6, M8–M14**. Milestone numbers stay as they are, so references to M8–M14
  keep working; the number 7 is simply unused.
- TB8 (model output → agent) leaves the threat model; there is no model whose output could be trusted.

Both moves are listed under "Explicitly out of scope" in `FEATURES.md`, so bringing either back takes
a change to that list and a new ADR, not an unchecked box.

## Consequences

- M14 is the last planned milestone. The project's plan ends there, and anything after it is a new
  decision.
- ADR-0010 is superseded. ADRs 0018, 0023, 0030, 0047, 0048 and 0049 mention M7, the models or the
  `triage` queue in their bodies, which stay as written; this ADR is the current rule.
- A future automation feature starts from nothing: no permissions, metric or enum value are kept
  waiting for it, because a placeholder that guards nothing is one more thing a reader has to rule out.
