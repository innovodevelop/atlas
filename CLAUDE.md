# Atlas — project guide for Claude Code

Atlas is a **local-first macOS desktop AI assistant**: a Tauri v2 app (React +
TypeScript webview, Rust core) with two Bun sidecars — an AI "brain" and a voice
gateway. Auth + billing run on Cloudflare; everything else runs on-device.

> This file is the **shared source of truth across Claude Code instances** (local
> CLI + web). Local auto-memory (`~/.claude/.../memory/`) and chat transcripts do
> NOT sync — put anything that must be shared here and commit it.

## ⚠️ Hard constraints — do not violate

- **NEVER run `cargo update`.** The build pins `vergen 9.0.6` / `vergen-gitcl
  1.0.5` (transitive via `librespot-core 0.8`); bumping them breaks the build.
  Change deps surgically, never a blanket update.
- **Bun only — no Node/npm/pnpm on the dev machine.** Use `bun install`,
  `bun run …`, `bun --bun run dev` (Bun 1.3.9).
- **Never commit secrets.** API keys live in the macOS Keychain (service
  `atlas-core`: gemini / perplexity / openweather / finnhub / news / elevenlabs)
  and in gitignored `.env` / `.dev.vars`. `AUTH_JWT_SECRET` is Cloudflare-only.
  The Spotify client secret and any Supabase service-role key / DB password must
  never be committed or handled in code — the user supplies those via env.

## Environment split — read before running anything

The **web / cloud environment is Linux** and **cannot**: build the Tauri macOS
`.app` (needs Xcode/macOS), access the Keychain, run the WKWebView, or the iOS
simulator. Use Web for **React/TypeScript webview, the Bun brain + voice-gateway,
Cloudflare Functions, and docs/refactors**. All **native build / verify / ship**
happens on the **macOS local CLI**. Secrets aren't in the repo, so anything that
needs a key must have it set in the Web environment's env-vars (or just run it on
the Mac).

## Layout

- `src/` — React webview. App screens in `src/pages/atlas/`, dashboard UI in
  `src/components/atlas-ui/`, styles in `src/styles/`; particle-sphere engine in
  `src/components/atlas/`.
- `src-tauri/src/` — Rust core: `db.rs` (SQLite app DB + sqlite-vec/FTS5 recall),
  `datafetch.rs`, `secrets.rs` (Keychain), `lib.rs` (commands + sidecar spawns).
- `services/atlas-brain/` — Bun HTTP sidecar (chat orchestrator + local memory).
- `services/voice-gateway/` — Bun sidecar (ElevenLabs TTS/STT).
- `supabase/functions/_shared/` — runtime-neutral orchestrator reused by brain.
- `design/brand-icons/` — Atlas particle-sphere icon sources + generator.
- `docs/architecture-local-first-migration.md` — the migration plan.

## Local-first migration (Supabase removed)

Supabase is gone. Local-first is the architecture, not a migration in progress.
- **Data:** SQLite core (rusqlite) + generic CRUD + Tauri events; sqlite-vec +
  FTS5 recall (local hybrid semantic search, ported from the old
  `recall_memories` RPC).
- **AI:** Bun "brain" sidecar (`services/atlas-brain/`) is the sole chat/tool
  orchestrator, importing the runtime-neutral `supabase/functions/_shared/`
  modules directly (that directory name is legacy — it holds shared TS, not a
  Supabase dependency). Reasoning is **Anthropic Claude first-party** for chat
  and **Amazon Bedrock (EU)** for background/batch work, selected per
  `ATLAS_AI_PROVIDER`; local `e5` embeddings for recall.
- **Auth = Cloudflare D1** (not local): email/password + entitlement on D1;
  users sign in / manage billing on web + app; Atlas itself runs locally.
  `supabase.from/channel/rpc` calls are shimmed to local equivalents
  (`src/integrations/local/localClient.ts`) — there is no Supabase client in
  the app.
- **Everything else local:** data-fetch (weather/stocks/news) → Rust;
  ElevenLabs → voice gateway; scheduler → local Tauri background task.
- **Inert leftovers (cosmetic only):** `@supabase/supabase-js` / `supabase` CLI
  / `postgres` deps, `tests/auth.spec.ts` and `supabase/migrations/` are still
  in the tree but sit on **no runtime path**. Other docs describe Supabase as
  "fully excised" — both statements are true and describe the same thing:
  excised from every code path, not yet deleted from disk.

## Where the plan lives

**`docs/ROADMAP.md` is the single source of truth** for what is done and what is
outstanding. Planning state used to be spread across five disagreeing sources,
so work was recorded as pending long after it shipped. Add phases, stages and
open items there — not to a new doc.

## Commands (native steps are macOS-only)

```bash
bun install
bun run dev            # webview dev server (Vite)
bun run build          # typecheck + vite build — must be clean before shipping
bun run tauri build --no-sign   # native .app + dmg — macOS only
```

Ship flow (macOS): `bun run build` → confirm no `VITE_PREVIEW_NOAUTH` in `dist/`
→ `bun run tauri build --no-sign` → install `.app` to `/Applications`.

**`--no-sign` is required for local builds.** The updater is configured with a
public key + `createUpdaterArtifacts`, which makes minisign signing mandatory at
bundle time; without the private key in the environment the build hard-fails
~15 minutes in, *after* the Rust compile. To build a genuinely updatable bundle
locally, `export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/atlas-updater.key)"`
and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""` first. Releases come from CI —
see `docs/RELEASE.md`.

## Conventions

- Converse in Danish; write code, UI copy, comments, and commit messages in
  English.
- Keep the WebGL / particle sphere unless told otherwise.
- Design CSS lands in `src/styles/workshop.css` verbatim-with-attribution;
  replace the design's mock data with real hooks.
- Machine-local Claude Code skills/settings (e.g. the `atlas-ship` skill) live
  outside this repo and are NOT available in Web — they're a local-CLI convenience.
