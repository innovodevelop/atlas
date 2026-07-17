# ADR 000 — Edge-function auth model (Workstream A)

**Status:** accepted · **Date:** 2026-07-17 · **Branch:** ws-a-auth

## Context

All 37 edge functions ran `verify_jwt = false`; `chat-with-memory` (and others)
read `userId` from the request body; ~19 functions used a service-role client,
bypassing RLS entirely. Anyone with the project URL could read any user's
profile, memories, and knowledge by POSTing an arbitrary `userId`.

## Decision

1. **Identity comes only from the verified JWT.** `_shared/auth.ts
   requireUser(req)` validates `Authorization: Bearer` via `auth.getUser()`
   and rejects the bare publishable key. `userId` is removed from every
   request-body schema and every client call site.
2. **`verify_jwt = true` for 32/36 functions.** The four exceptions, each
   documented in `config.toml`: `record-usage-snapshot`, `atlas-daily-digest`,
   `mail-sync` (pg_cron targets — guarded in code by `requireCronSecret`,
   header `x-cron-secret`), and `mail-oauth-callback` (browser redirect from
   Google — authenticated by the single-use server-held PKCE state row).
3. **Dual-mode guard for the internal learning chain.**
   `requireUserOrInternal(req)` accepts either a user JWT (identity = token)
   or the cron secret (internal caller may target a user explicitly in the
   body). Used by: atlas-knowledge, atlas-knowledge-validator, atlas-research,
   atlas-topic-discovery, atlas-control, knowledge-layer, validation-engine,
   memory-synthesize, memory-scheduler, generate-embeddings, atlas-brain,
   mail-sync. Internal fetches send `Authorization: Bearer <service-key>`
   (passes the platform gate) **plus** `x-cron-secret`.
4. **RLS-respecting client is the default.** `getUserClient(token)` (anon key
   + user JWT). Service role survives only where RLS genuinely can't apply,
   with a one-line justification at each site: system tables
   (provider status/settings/learning logs), OAuth state + encrypted-token
   columns (revoked from clients), cross-user cron iteration, and the agent
   scaffolding (which verifies the JWT in code and scopes by the verified id).
5. **Cron secret lives in Supabase Vault** (`cron_secret`) so the rescheduling
   migration can reference it without the value entering git; the same value
   is the `CRON_SECRET` function secret. `EVENTS_WEBHOOK_KEY` similarly
   validates `X-API-Key` on `/events/ingest` (previously ANY non-empty header
   was accepted).
6. **Permissive policies:** all 19 `(true)` policies sat on system tables the
   client only reads. Reads re-scoped `TO authenticated`; permissive write
   policies dropped (writers are service-role and bypass RLS).

## Consequences

- Anonymous and publishable-key-only callers get 401 everywhere user data is
  reachable; cross-user reads are blocked by both derivation and RLS.
- pg_cron jobs fail (403) until the Vault secret + `CRON_SECRET` are set —
  deploy order: secrets → migration → functions.
- `stocks-realtime` (dead, unauthenticated WS endpoint with zero client
  references) was deleted rather than hardened.
- Found-in-passing: `schedules`/`events` call `agent-run` with the service key
  as bearer; `agent-run` runs `auth.getUser()` on it, which likely fails —
  scheduled agent runs were probably already broken. Not fixed here; flagged
  for Workstream B/D when the approvals flow is exercised.
