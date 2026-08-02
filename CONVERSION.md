# Atlas Mac App — Conversion Guide

> **SUPERSEDED (2026-08-02).** Kept for history only — do not act on
> this document. Current state and open work: `docs/ROADMAP.md`.

Everything code-side is done on the `mac-app-conversion` branch. This file
covers the manual steps only you can do (accounts, keys, deploys) and how to
verify each phase.

## STATUS (2026-07-04)

| Step | State |
|------|-------|
| Own Supabase project ("AtlasAI", `gdhdqetwlinlpimpxokp`, eu-west-2) | ✅ created, linked, 16 migrations pushed |
| Edge functions | ✅ all 33 deployed |
| Cron jobs (pg_cron migration) | ✅ usage snapshot 00:00 UTC, digest 06:00 UTC — these also double as free-tier keep-alive pings |
| `.env` → new project | ✅ verified: app only contacts the new project |
| Containment trigger | ✅ verified live (unsessioned insert rejected) |
| **Edge function secrets** | ❌ TODO — `GEMINI_API_KEY` (required), `ELEVENLABS_API_KEY` (voice), optional others (step 1.5 below) |
| **Account** | ❌ TODO — sign up in the app, or run migration script for old data (step 2) |
| Mac app build | see `src-tauri/target/release/bundle/` |

## What changed (already committed)

| Phase | Commit | Summary |
|-------|--------|---------|
| 1 | `aiGateway` | Lovable AI gateway replaced by `_shared/aiGateway.ts` — works with `GEMINI_API_KEY` (Google AI Studio, OpenAI-compatible endpoint) or legacy `LOVABLE_API_KEY`. Real 768-dim Gemini embeddings replace the fake (LLM-hallucinated / SHA-256) ones. De-Lovable'd build (no `lovable-tagger`, Bun-only). |
| 2 | containment | Research is conversation-scoped: DB trigger `enforce_session_limits` rejects any research topic without an active session or over the limits (max topics, max depth from `atlas_system_settings`, max 2 sub-topics per parent, 15-queued circuit breaker). `atlas-topic-discovery` + `atlas-news-pulse` disabled behind `global_discovery_enabled` (default off). `atlas-brain` is session-driven. Semantic dedup before enqueue. Tighter learning-intent detection. |
| 3 | digest + personality | `atlas-daily-digest`: one budgeted cycle/day following up ONLY on your recent conversation topics → speakable `ai_insights`. Conversation summaries + learned communication style feed the system prompt. `memory-synthesize` extracts tone preferences and falls back to Gemini without an Anthropic key. |
| 4 | Tauri | `src-tauri/` scaffold (compiles), mic entitlement + usage description, CSP, overlay title bar, app icon. WKWebView audio fix: MediaRecorder negotiates webm→mp4 (`src/lib/audioFormat.ts`), STT accepts either. |
| 5 | performance | Everything pauses when the window is hidden/blurred (`useWindowActivity`): sphere frameloop, weather 3D, card atmospheres, all polling. Atmospheres memoized + trimmed. Adaptive sphere quality (FPS-based degradation) wired in. All dashboard cards memoized. Query cache persisted to disk → instant startup. Bundle split (three/mermaid/recharts). |

## Manual step 1 — Create your own Supabase project (~30 min)

1. Create a project at https://supabase.com (region: eu-central). Note the
   **project ref**, **anon key**, **service-role key**, **DB password**.
2. Dashboard → Database → Extensions → enable **vector** (pgvector).
3. Link and push the schema (15 migrations, includes the containment one):
   ```sh
   cd helloatlas
   bunx supabase login                 # opens browser
   bunx supabase link --project-ref <REF>
   bunx supabase db push
   ```
4. Deploy all 36 edge functions:
   ```sh
   bunx supabase functions deploy
   ```
5. Set secrets (Dashboard → Edge Functions → Secrets, or CLI):
   ```sh
   bunx supabase secrets set \
     GEMINI_API_KEY=...        # aistudio.google.com/apikey  (REQUIRED — replaces Lovable AI)
     ELEVENLABS_API_KEY=...    # voice (required)
     PERPLEXITY_API_KEY=...    # research citations (recommended)
     ANTHROPIC_API_KEY=...     # memory synthesis (optional, Gemini fallback exists)
     OPENWEATHER_API_KEY=... NEWS_API_KEY=... FINNHUB_API_KEY=... FIRECRAWL_API_KEY=...
   ```
6. Update `.env` in the repo:
   ```
   VITE_SUPABASE_URL="https://<REF>.supabase.co"
   VITE_SUPABASE_PUBLISHABLE_KEY="<anon key>"
   VITE_SUPABASE_PROJECT_ID="<REF>"
   ```

## Manual step 2 — Migrate your data (~15 min)

Check Lovable project settings for "Manage in Supabase". If available, prefer
`bunx supabase db dump --db-url <lovable-conn> --data-only` + psql restore.
Otherwise run the included script (skips the runaway research garbage and the
broken legacy embeddings on purpose):

```sh
OLD_SUPABASE_URL=https://gyfllxzecctdnmxqgazo.supabase.co \
OLD_ANON_KEY=<old anon key from .env history> \
OLD_EMAIL=<your login> OLD_PASSWORD=<your password> \
NEW_SUPABASE_URL=https://<REF>.supabase.co \
NEW_SERVICE_ROLE_KEY=<service key> \
bun run scripts/migrate-data.ts
```

Then rebuild the (now real) semantic memory vectors:
```sh
bunx supabase functions invoke generate-embeddings --body '{"batchSize": 20}'
# repeat until "created: 0"
```

## Manual step 3 — Cron jobs (~5 min)

The `[[cron_jobs]]` blocks in `supabase/config.toml` are Lovable-only syntax.
On your project: Dashboard → Integrations → Cron (pg_cron) → create two jobs
that POST to the edge functions (with the anon key as Bearer):

| Name | Schedule | Function |
|------|----------|----------|
| daily-usage-snapshot | `0 0 * * *` | `record-usage-snapshot` |
| atlas-daily-digest | `0 6 * * *` | `atlas-daily-digest` |

Dry-run the digest anytime:
```sh
bunx supabase functions invoke atlas-daily-digest --body '{"dryRun": true}'
```

## Manual step 4 — Run the Mac app

```sh
bun run tauri dev      # dev with hot reload
bun run tauri build    # .app + .dmg in src-tauri/target/release/bundle/
```

Signing (optional, for distribution): set `APPLE_SIGNING_IDENTITY`,
`APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID` and rebuild —
Tauri notarizes automatically. Unsigned personal use: right-click → Open once.

## Verifying the learning containment

1. In the app, re-enable learning (Atlas Health → Learning Control).
2. Chat: "Atlas, research the history of espresso machines."
3. SQL editor:
   ```sql
   select topic, status, depth_level, learning_session_id
   from atlas_research_topics order by created_at desc limit 20;
   select root_topic, status, topic_count, token_cost
   from atlas_learning_sessions order by created_at desc limit 5;
   ```
   Expect: topics ≤ `max_topics_per_session` (default 3), depth ≤ 2,
   session ends `completed`. 
4. Prove the trigger: `insert into atlas_research_topics (topic, status) values ('x','queued');`
   → must ERROR with "learning_session_id is required".
5. Prove the feeders are dead: `bunx supabase functions invoke atlas-topic-discovery`
   → `{"disabled": true}`.

## Security follow-up (not blocking)

All functions still run `verify_jwt = false` (needed for internal
function-to-function calls). Fine for personal use; before ever exposing the
project publicly, enable JWT verification on user-facing functions and pass
the user's JWT from the frontend.

## Known cosmetic issue (pre-existing)

`/atlas-demo` logs React `validateDOMNesting` warnings (button inside button
in `CollapsibleSection`). Present before the conversion; harmless.
