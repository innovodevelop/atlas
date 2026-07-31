# Atlas — local-first migration (Supabase removed)

**Status: complete.** All 8 phases below have shipped — Supabase is fully
excised (client, all edge functions, `_shared/supabase.ts`). This doc is kept
as the historical record of the decision and the phase sequence; see
`CLAUDE.md` for the current architecture summary and the follow-up cleanup
items (test/script/dep references) tracked outside the app runtime.

**Decision (2026-07-21):** remove Supabase completely; go **fully local-first**
with **one thin always-on worker** for 24/7 mail (user requires mail scanning
while the Mac is off — the only thing that cannot be 100% local).

## Why

Continues the established trajectory (DuckDB portfolio, local voice gateway,
librespot music, "our Supabase can't handle this", privacy-forward internal
tool of 5–10). Endpoint: sensitive data (memories, mail bodies, voiceprints)
never leaves the Mac; no vendor dependency/cost; realtime becomes free
(in-process events); offline-capable.

## Supabase footprint being replaced (confirmed in-code)

36 edge functions · ~40 Postgres tables (RLS) · pgvector 768-dim +
`recall_memories` hybrid RPC · pg_cron (mail-sync /15m, daily digest, usage) ·
realtime driving **10 hooks** (agents, approvals, tool_calls, proactive AI,
research, mail, knowledge, provider status) · email/password auth · edge
secrets + Vault.

## Target architecture

| Concern | Target |
|---|---|
| App database | **SQLite** in Tauri Rust backend (new `db.rs`, mirrors `portfolio_db.rs` which stays DuckDB for analytics) |
| Semantic memory | **sqlite-vec** (vector) + **FTS5** (keyword) → port `recall_memories` hybrid scoring to a local query; 768-dim embeddings via the brain sidecar (Gemini) or a local ONNX embedder (onnxruntime already in-tree) |
| Chat/AI/tools | **Bun "brain" sidecar** (`services/atlas-brain`, spawned like voice-gateway). `_shared/orchestrator.ts` is already runtime-neutral — imports directly. AI gateway (Gemini), tool loop, learning tasks live here |
| Voice tokens/STT/TTS | fold `elevenlabs-*` into the existing **voice gateway** (keys from Keychain) |
| weather/stocks/news | brain sidecar or direct Rust `ureq` calls; keys from Keychain |
| Realtime (10 hooks) | **Tauri events** (`app.emit`) + local DB queries — rewrite hooks to `listen()` instead of Supabase `.channel()` |
| Secrets | **macOS Keychain** via `keyring` (established: `atlas-snaptrade`, `atlas-music`; add `atlas-core` for Gemini/ElevenLabs/etc.) |
| Auth | **local profile** in SQLite; drop cloud accounts + JWT/RLS (single local trust boundary). `requireUser` etc. deleted |
| Catch-up crons (digest, usage) | **local scheduler** (Tauri background task), runs/catches up on launch |
| **24/7 mail (the one cloud piece)** | **thin Cloudflare Worker** (Cron /15m) holding ONLY the encrypted Gmail refresh token + a queue of new-message-IDs + alert flags. Detects important mail, sends a notification; the local app fetches bodies + analyses + stores locally on wake. Mail bodies/memories never in cloud. *(Zero-cloud alternative: a local `launchd` agent does the same poll if the Mac stays awake.)* |

## Phased roadmap (each phase shippable; not big-bang) — ALL DONE

1. **Local data layer** — DONE. SQLite `db.rs` + schema mirroring the Postgres tables; one-time importer pulled the live Supabase data → local. App reads/writes go through Rust commands.
2. **Brain sidecar** — DONE. `services/atlas-brain` (Bun) imports `orchestrator.ts` from `supabase/functions/_shared/` (name is legacy, no Supabase dependency); routes chat + AI-gateway + tools. `chat-with-memory` + the AI edge functions retired.
3. **Memory/vectors local** — DONE. sqlite-vec + FTS5; `recall_memories` ported to a local hybrid query; embeddings local (e5). Memory/search/embeddings functions retired.
4. **Realtime → events** — DONE. The realtime hooks were rewritten to Tauri events (`app.emit`/`listen`) + local queries; Supabase channels are gone (`localClient.ts` stubs `.channel()`).
5. **Voice + data-fetch functions local** — DONE. `elevenlabs-*` folded into the voice gateway; weather/stocks/news moved to Rust.
6. **Auth local** — DONE, but landed as **Cloudflare D1**, not a local-only profile (see CLAUDE.md): email/password + entitlement live on D1 so web + app share one account; Atlas itself still runs fully local otherwise. JWT/RLS/`requireUser` deleted with the Supabase auth dependency.
7. **Mail: local, no cloud worker** — DONE, but decided differently than drafted: consumer mail stays **local-only** (no thin Cloudflare mail-cron worker); see the Phase 7b decision record. 24/7 mail-while-Mac-is-off was deprioritized rather than solved with the cloud piece described below.
8. **Delete Supabase** — DONE. Client, all 34 edge functions (2 fewer than the 36 originally inventoried — some were already-dead duplicates), and `_shared/supabase.ts` removed. `supabase/migrations/`, the `supabase` CLI config, and the `@supabase/supabase-js`/`postgres` deps are tracked as a separate follow-up cleanup (blocked on `tests/auth.spec.ts`, owned outside this migration) — they are inert, not part of the running app.

## Risks / honest caveats
- Biggest change in the project; multi-week; entangled with in-flight WS-B (voice) + music. Sequence deliberately.
- The 24/7 mail worker **must** hold a cloud-side Gmail refresh token (encrypted) — this is the irreducible privacy cost of "works while Mac is off". The local core holds everything else.
- Local embedding: decide Gemini-API (needs network per embed) vs a bundled ONNX embedder (offline, larger app). Recommend starting Gemini, add local model later.
- No multi-device sync after this (was implicit via Supabase). Acceptable per the local-first decision; revisit if the team needs shared state.
