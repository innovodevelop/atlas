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

- `src/` — React webview. Aurora UI in `src/pages/aurora/` + `src/styles/`;
  particle sphere in `src/components/atlas/`.
- `src-tauri/src/` — Rust core: `db.rs` (SQLite app DB + sqlite-vec/FTS5 recall),
  `datafetch.rs`, `secrets.rs` (Keychain), `lib.rs` (commands + sidecar spawns).
- `services/atlas-brain/` — Bun HTTP sidecar (chat orchestrator + local memory).
- `services/voice-gateway/` — Bun sidecar (ElevenLabs TTS/STT).
- `supabase/functions/_shared/` — runtime-neutral orchestrator reused by brain.
- `design/brand-icons/` — Atlas particle-sphere icon sources + generator.
- `docs/architecture-local-first-migration.md` — the migration plan.

## Local-first migration (in progress)

Migrating off Supabase to local-first.
- **Done:** SQLite core (rusqlite) + generic CRUD + Tauri events; brain sidecar;
  sqlite-vec + FTS5 recall; Cloudflare **D1** email/password auth + entitlement;
  app rewired to CF auth; `supabase.from/channel/rpc` shimmed to local
  (`src/integrations/local/localClient.ts`); data-fetch (weather/stocks/news) →
  Rust; ElevenLabs → voice gateway; brain on CF-JWT + fully local via bun:sqlite.
- **Auth = Cloudflare D1** (not local): users sign in / manage billing on web +
  app; Atlas itself runs locally.
- **Pending:** Phase 7 (mail + thin CF worker + local scheduler), Phase 8 (delete
  remaining Supabase client + edge fns — only after the ~6 edge deps migrate),
  Phase 9 (billing, last).

## Commands (native steps are macOS-only)

```bash
bun install
bun run dev            # webview dev server (Vite)
bun run build          # typecheck + vite build — must be clean before shipping
bun run tauri build    # native .app + dmg — macOS only
```

Ship flow (macOS): `bun run build` → confirm no `VITE_PREVIEW_NOAUTH` in `dist/`
→ `bun run tauri build` → install `.app` to `/Applications`.

## Conventions

- Converse in Danish; write code, UI copy, comments, and commit messages in
  English.
- Keep the WebGL / particle sphere unless told otherwise.
- Design CSS lands in `src/styles/aurora.css` verbatim-with-attribution; replace
  the design's mock data with real hooks.
- Machine-local Claude Code skills/settings (e.g. the `atlas-ship` skill) live
  outside this repo and are NOT available in Web — they're a local-CLI convenience.
