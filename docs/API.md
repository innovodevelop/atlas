# Atlas API Reference — superseded

This document used to catalog Supabase Edge Functions HTTP endpoints on a now-
deleted project ref. Supabase (and every edge function it hosted) has been
removed from Atlas; there is no HTTP API surface to document in its place —
the app is local-first.

- **Chat/AI/tools:** in-process calls into the Bun brain sidecar
  (`services/atlas-brain/`), which imports the runtime-neutral orchestrator in
  `supabase/functions/_shared/` (directory name is legacy) directly — no HTTP
  hop, no separate API contract. Reasoning is Anthropic Claude (chat) and
  Amazon Bedrock EU (background), selected via `ATLAS_AI_PROVIDER`.
- **Data (memory/knowledge/settings/etc.):** Tauri Rust commands over the
  local SQLite DB (`src-tauri/src/db.rs`), or the `supabase.from/channel/rpc`
  shim (`src/integrations/local/localClient.ts`) that call sites still use for
  minimal-diff compatibility.
- **Voice:** the local voice-gateway sidecar (`services/voice-gateway/`).
- **Auth + entitlement:** Cloudflare D1 (see `docs/decisions/000-auth-model.md`
  and the CLAUDE.md architecture summary) — the one piece that isn't local.

See `CLAUDE.md` for the current architecture and
`docs/architecture-local-first-migration.md` for how the app got here.
