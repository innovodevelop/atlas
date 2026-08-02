# Atlas — Strategy-Anchored Codebase Audit

> **SUPERSEDED (2026-08-02).** Kept for history only — do not act on
> this document. Current state and open work: `docs/ROADMAP.md`.

**Date:** 2026-07-24 · **Commit:** `3e54e86` on `atlas-redesign` · **Method:** read-only sweep by six parallel evidence agents + one adversarial verification pass; every claim below cites `path:line`. Sibling repo `../atlas-site` included where relevant.

---

## 1. Executive summary

Atlas today is a genuinely local-first-leaning macOS assistant whose **strongest strategic asset is exactly the thing the strategy treats as future work: memory** — a runtime-composed system prompt fed by per-message semantic recall over on-device SQLite, implemented three times consistently and live in every chat turn. Around that core, however, the half-finished Supabase migration has severed the loops the strategy depends on: voice still authenticates against Supabase and fails in the current build, memory hygiene (consolidation, decay, dedupe) executes against the abandoned cloud database, and the learning/research engine is dark locally. The second structural fact: **nothing is being captured** — no transcripts persist (the `messages` table has zero writers), no feedback signal of any kind exists, and no Terms/Privacy documents exist despite the signup screen claiming they do — so the Atlas-1 fine-tune has no raw material accumulating and the EU posture rests on architecture, not compliance. Third: the self-dev containment stack is 0% enforced — the app is effectively unsigned, the two sidecar binaries are exec'd every launch with no integrity check, there is no updater, no rollback, no kill switch, and CI does not even trigger on the working branch. The strategy's ordering is half right: memory+personality is confirmed as the best perceived-uniqueness-per-effort bet (the injection seam is clean; a new module suffices), but "abstraction first" is wrong — escalation is a one-file change at an existing choke point, while the real prerequisites are finishing the migration cuts and starting data capture + the legal floor immediately, because both compound with time. The "global brain is our largest legal surface" claim is wrong today: the global brain is 0% built, and the actual legal surface is intimate personal data flowing to four US processors with no DPA, no erasure path, and a consent sentence pointing at documents that don't exist.

---

## 2. Claim-by-claim findings

### Claim 1 — Providers are assemblies behind a kept abstraction layer → **PARTIALLY REFLECTED, CONTRADICTED on escalation** · Readiness **2/5**

**Reflected:** Gemini is fully contained in one gateway — `supabase/functions/_shared/aiGateway.ts:17-21,103,143` holds the only `generativelanguage.googleapis.com` URLs in the repo (chat, embeddings, doc-extract), reused by 15+ files including the brain sidecar (`services/atlas-brain/src/index.ts:31`).

**Contradicted:**
- Perplexity is **8 raw fetch sites, zero gateway**: `orchestrator.ts:402,430`, `atlas-research/index.ts`, `atlas-news-pulse`, `atlas-topic-discovery`, `validation-engine`, `tool-gateway` (×2). Anthropic is 2 more (`agent-run`, `memory-synthesize`) with hand-rolled Messages-format adaptation (`agent-run/index.ts:171-207`). The `PROVIDERS` config block is copy-pasted 4× with drifting contents.
- **The escalation router exists and is dead code.** `supabase/functions/_shared/providerRouting.ts` (361 lines) implements task-tier escalation to `claude-sonnet-4-5`/`gpt-5` — and has **zero importers** anywhere (verified twice).
- The live path pins **every** query to one model: `orchestrator.ts:110-111` `google/gemini-2.5-flash`, used at `:859,:923,:992`. No code path ever escalates a hard query.
- Streaming is not uniform: only the Gemini gateway path streams; all Perplexity/Anthropic calls are non-streaming with per-site shims. Tool schemas are provider-coupled (`agent-run/index.ts:216` sends tools only `if provider === "lovable"`).

**The seam exists:** `aiGateway.ts:58-91` — every completion flows through `mapModel()` + `aiChatCompletion()`, and the map already knows a stronger tier (`"openai/gpt-5": "gemini-2.5-pro"`, `:53`). A difficulty classifier setting `body.model` before this choke point is a small change.

**Gap:** consolidate the 10 bypassing call sites into the gateway; wire (or delete) the dead router.

### Claim 2 — The reranker decides answer quality → **SILENT (component absent); premise partially inverted** · Readiness **1/5**

- **Cross-encoder reranking: MISSING everywhere.** `rg -i 'rerank|cross-encoder|cohere|bge-'` → zero relevant hits. The ONNX assets are the wake-word engine (`src/lib/wakeWord.ts`), not a reranker.
- **Web retrieval is wholesale Perplexity delegation** (`orchestrator.ts:400-425`): no owned search client, no crawler (single-URL Jina/Firecrawl readers only), no chunking (only truncation: 10k chars `orchestrator.ts:466`), no web embeddings, no web vector store. **There is no candidate set to rerank on the web side.**
- **Memory retrieval is real**: sqlite-vec KNN + FTS5 hybrid (`src-tauri/src/db.rs:386-440` — 0.65·sim + 0.35·bm25 × recency × importance, unit-tested), with consistent JS (`localMemory.ts:115-160`) and Postgres ports. Ranked by a hand-tuned linear formula, not a reranker.
- **The insertable slot already exists**: `db.rs` over-fetches 8× candidates (`k = match_count*8`) before the linear score truncates. Wiring a cross-encoder there touches: `db.rs`, `localMemory.ts` + brain `index.ts` (`/search`, `/chat-with-memory`), `orchestrator.ts:789-840`, a new rerank client (API or ONNX riding the existing `public/ort` runtime), `useBrainSearch.ts`/`BrainSearchPanel.tsx`.

**Gap (M2's highest-leverage):** rerank over **memory-recall** candidates now; owned web retrieval (search→fetch→chunk→embed) is a precondition before web reranking means anything.

### Claim 3 — Atlas-1 is a fine-tune, not from-scratch → **REFLECTED on the negative half, SILENT on the positive; the data does not exist** · Readiness **0/5**

- Local LLM inference runtime: **MISSING** — no llama.cpp/MLX/Ollama/candle anywhere; `onnxruntime-web` serves only wake-word (`wakeWord.ts:17`) and Silero VAD. All generation is cloud (`atlas-brain/src/index.ts:143`).
- Model weights: only ~3.7MB of voice ONNX (`public/models/`, `silero_vad.onnx`). **Zero LLM weights** → no license blocker. But license hygiene is PARTIAL: "MIT/Apache" exists only as a code comment (`wakeWord.ts:4`, ADR 002); **no LICENSE/NOTICE files vendored** — fixable shipping gap. The wake phrase is literally the stock "Hey Jarvis" placeholder.
- **SFT-usable logging: MISSING.** `conversations`/`messages` tables exist (`db_schema.sql:53-68`) with **zero readers or writers** (verified twice); chat dies in React state; the `messages` schema can't even hold system/tool roles (`:64` CHECK constraint); the system prompt composed at `orchestrator.ts:829` is never persisted. The near-SFT `runs`/`run_steps`/`tool_calls` tables are written only by an unreachable Supabase edge fn.
- **Success signal: MISSING** — no thumbs/rating/feedback UI, no reward column, nothing ties outcomes to generations. As the brief predicted: **this is a bigger gap than the model.**
- **Consent: MISSING** — the entire consent surface is one unlinked sentence (`src/pages/Auth.tsx:202`); no Terms/Privacy document exists in either repo; no training-use language anywhere.
- **Falsification: CONFIRMED ABSENT** — no corpus collection, tokenizer training, GPU config, datasets. No sunk cost to stop. But symmetrically, no fine-tuning work exists either; "Atlas-1", "LoRA", "SFT" appear nowhere in the repo.

**Gap:** the behavioural dataset is not accumulating a single example per day of use. Logging tuple + one reward signal + consent must start long before any model work.

### Claim 4 — "It learned about me" is memory, not weights → **REFLECTED at core, with correctness defects and false "deletable"** · Readiness **3/5**

**What persists (all in plaintext `atlas.db`):** fact/preference store `ai_memory` written live from chat via the `memory_store` tool (`orchestrator.ts:469-487`, 17 categories incl. `personality`, `fears`) and read every turn (top-10 by importance, `:774`); episodic summaries (`:571-615`, last 3 injected); session working memory with 30-min expiry (`:617-701`); semantic recall per message (embed → `recall_memories` → inject, `:792-809`). Live end-to-end: webview → brain `/chat-with-memory` → `runChat` on bun:sqlite.

**The system prompt is COMPOSED at runtime** — the structural blocker the brief feared does not exist. `buildPersonalizedPrompt` (`orchestrator.ts:246-383`, selected at `:829`) interpolates profile, memories, style notes, summaries, knowledge, life events, and per-message recalled memories (`:833-836`). Same composed prompt serves text and voice.

**Defects that contradict the claim's adjectives:**
- *"Deletable" is false today*: no forget/delete UI exists (zero `.delete()` on `ai_memory` in `src/`), and the deletion/pruning machinery (memory-scheduler/-synthesize) executes against **abandoned Supabase Postgres** via the shim's fallback (`localClient.ts:374-411`) — it cannot touch the local DB where memories live.
- *Instant, but corrupting*: the local `upsert` is `INSERT OR REPLACE` on a fresh UUID with **no `UNIQUE(user_id,key)`** (`localDb.ts:70,130`; schema verified) — restating a fact **duplicates** it instead of updating.
- *Recall goes stale*: new memories get no embedding automatically; vectors are created only by a manual `/embed-backfill` button (`BrainSearchPanel.tsx:85`).
- Conversation history: **MISSING** (see Claim 3). `user_life_events` is read into the prompt (`:776-785`) but has **no writer anywhere**. Knowledge extraction is dead locally (`learning_enabled` defaults 0 with no seed row; the trigger fetches `local/functions/v1/atlas-knowledge`, a dead URL). The comment "consolidation decays what never recalls" (`orchestrator.ts:837`) describes a loop that does not exist locally — `last_accessed` is touched and never read.
- Per-speaker identification: **MISSING** — one flat `user_id` from the JWT; household vs individual is not modelled.
- Anything built as though learning happens in weights: **NONE.**

### Claim 5 — Personality is bounded state → **CONTRADICTED today; the seam is clean** · Readiness **1/5**

- Atlas's persona is a **hardcoded prose constant** — "warm, witty… light jokes, playful teasing, the occasional pun" (`orchestrator.ts:318-327`). Not state, not bounded, not per-user. Humour is *mandated unconditionally*.
- In embryo: one `communication_style` string (`db_schema.sql:37`, no UI writer); a **live injection slot** for learned style notes ("## Communication Preferences You've Learned", `orchestrator.ts:271-274,787`) whose **only producer is severed** (memory-synthesize runs Supabase-side against the wrong DB); a `personality` memory category that stores the *user's* traits, not Atlas's. No trait vector, no nickname lexicon, no humour tracking, no per-speaker profiles.
- **The seam:** exactly one assembly point — `buildPersonalizedPrompt` + the proven `systemPromptOverride` escape hatch (`orchestrator.ts:829`; already exercised by `AtlasTeach.tsx:132`). Edge fn, brain, and voice gateway all run the same `runChat`, so a `composePersonality(state)` module lands on all three surfaces at once. **New module, no restructuring.** Caveat: prompt injection is the *only* lever — `aiGateway.ts` passes no sampling/steering parameters at all.
- **Sycophancy:** no approval-shaped feedback exists (nothing to overfit to — and zero signal). Non-approval signals already in schema but feeding nothing: `user_tasks.completed`, `ai_memory.mention_count`, `atlas_knowledge_entries.access_count`, `memory_vectors.last_accessed`. Capturable today.
- **Humour gating: does not exist.** Keyword emotion detection ("stressed", "sad" → `session_context`, `orchestrator.ts:656-671`) surfaces as a prompt hint the model may ignore; no code path suppresses or conditions the humour instruction.

### Claim 6 — Atlas must never modify its running binary → **ASPIRATIONAL, NOT ENFORCED; violable today** · Readiness **1/5**

Treated as a security review; per-item "can this be violated today?":
- **Signing: MISSING.** No `signingIdentity`/notarization anywhere in `tauri.conf.json` (the `"active": true` at `:39` merely enables *bundling*); `oauth.rs:9-11` designs around being unsigned ("signed or not… when Atlas gains an Apple Developer Team ID"). Ad-hoc signature ⇒ a replaced binary is not rejected at launch.
- **Updater: MISSING.** No `tauri-plugin-updater` (`Cargo.toml:25-28`), no release channel, version static `0.1.0`. The only updater-adjacent code (`lib.rs:195-232`) *accommodates* in-place binary replacement (purges caches on mtime change) without verifying who replaced it.
- **The most direct violation path today:** both sidecars are exec'd every launch from the bundle **with no hash/signature check** (`lib.rs:35-54, 90-111`). Anything with user-level write access to `/Applications` — including a future dev-agent — can swap `atlas-brain` and Atlas silently runs it.
- **Self-modifying code: none found** (no `eval`/`new Function`; dynamic imports are literal; no writes into install dir; AI tool set is fixed with no code-exec/fs/shell tool — `orchestrator.ts:388-487`). The *app* doesn't self-modify; the *environment* doesn't prevent modification.
- **Sandbox: NO OS sandbox** (`Entitlements.plist` lacks `com.apple.security.app-sandbox`; sidecars run with full user authority). The Tauri capability manifest is genuinely minimal (`capabilities/default.json:8-13` — core/notification/opener/deep-link only; no fs/shell/http) — the best part of the story. CSP allows `'unsafe-inline'` scripts (`tauri.conf.json:28`) — zero defense-in-depth if an injection sink ever appears.
- **Flags/tiers: decorative and spoofable.** `hasFeature()` has zero call sites; entitlement lives in plaintext localStorage (`authClient.ts:24-52`); the brain decodes JWTs **without signature verification** (`atlas-brain/src/index.ts:60-91`). Flags cannot serve as containment or kill-switch levers.
- **Trust domain: one.** Webview IPC can write Keychain secrets + full DB CRUD; capabilities/CSP/CI live in the same repo a dev-agent would edit; **CI does not trigger on the working branch** (`ci.yml:5` still names `aurora-redesign`; branch is `atlas-redesign`).
- **Rollback/kill switch: MISSING** (a "killed" account keeps working offline since gating is unused and tokens unverified).

### Claim 7 — The global brain is the largest legal surface → **CONTRADICTED: the actual legal surface is elsewhere** · Readiness **2/5**

- **No telemetry/analytics/crash reporting: CONFIRMED** — the exhaustive sweep found none. Architecture is genuinely privacy-leaning: on-device wake word, ephemeral audio, Keychain secrets, hashed IPs (D1 waitlist), AES-GCM mail refresh tokens (`_shared/crypto.ts:9-23`).
- **Egress that does exist** (full table in the JSON companion): full chat turns + system prompt **embedding the user's stored memories** to Google Gemini every memory-enabled turn (`orchestrator.ts:256-338` → `aiGateway.ts:19`); raw microphone PCM of *whoever is speaking* to ElevenLabs post-wake (`session.ts:117-118`, `stt.ts:21`); queries to Perplexity; memories to Anthropic (memory-synthesize); Gmail metadata still round-tripping Supabase mid-migration (`localClient.ts:374-411`); brokerage holdings to SnapTrade (`snaptrade.rs:19,89-121`); lat/lon to OpenWeather; **user IP to Google Fonts on every launch and every site visit** (`index.html:14-19` both repos — the LG München problem); researched-source domains to Google via favicon fetches (`CitationsList.tsx:33`).
- **Erasure: MISSING for cloud stores.** No D1 account/waitlist deletion endpoint (`atlas-site/functions/api/` has only login/signup/verify/me); no account-level wipe of Supabase remnants; local erasure = manually deleting `atlas.db` (undocumented). Data export (Art. 20): missing everywhere. Mail-disconnect is the one good path (revoke + cascade delete).
- **Consent: phantom.** `Auth.tsx:202` "you agree to our Terms & Privacy Policy" — **neither document exists in either repo.** No household/second-party consent surface; once awake, any voice in range streams to a US processor.
- **Voice/biometrics:** audio is ephemeral (no PCM persistence found; diarization explicitly `"false"`, `elevenlabs-stt/index.ts:73`) — no Art. 9 processing *today*; transcripts are retained as plaintext rows. The planned per-speaker identification would change the Art. 9 analysis — build the consent surface first.
- **Global brain: 0% built.** `global_discovery_enabled` (`db_schema.sql:596`) is a false friend — single-user news-topic discovery. No cross-user sharing, no corroboration thresholds, no reputation weighting, no opt-in flow, no poisoning defense. Every mechanism the claim calls "guaranteed" is unwritten — and the *legal* exposure of the global brain is therefore currently zero.

---

## 3. Scorecard

| Milestone | Score | Justification |
|---|---|---|
| **M1 — abstraction** | **2/5** | One real gateway (Gemini) + a clean escalation choke point (`mapModel`), but 10 raw provider call sites, 4 drifting config copies, non-uniform streaming, and a 361-line dead router. |
| **M2 — retrieval** | **1/5** | Solid *memory* recall (sqlite-vec+FTS5 hybrid, triply ported, unit-tested); zero reranker anywhere; web retrieval is wholesale Perplexity with no owned pipeline to rerank. |
| **M3 — memory + personality** | **2/5** | Memory core is live and composed-at-runtime (3/5) but "deletable" is false, hygiene loops are severed, upsert duplicates facts; personality is a hardcoded prose constant (1/5) with one clean seam. |
| **M4 — Atlas-1** | **0/5** | No local inference, no LLM weights, no SFT logging (messages table has zero writers), no success signal, no consent — the dataset is not accumulating. |
| **M5 — admin self-dev** | **1/5** | Minimal capability manifest and fixed tool set earn the point; signing, updater, sandbox, enforced approval, rollback, kill switch all missing; CI doesn't run on the working branch. |
| **M6 — global brain** | **0/5** | Nothing cross-user exists — no sharing, no distillation, no opt-in, no poisoning defense. (Which also means zero current legal exposure from it.) |

---

## 4. Where our strategy is wrong

1. **"The global brain is the largest legal surface" — wrong today.** The global brain is 0% built. The *live* legal surface is: intimate memories in prompts to Google, raw voice to ElevenLabs, memories to Anthropic, mail metadata through Supabase — four US processors with no DPA/SCC record anywhere in the repos — plus a phantom Terms/Privacy, no erasure endpoint, and Google-Fonts IP egress on the EU-facing site. The strategy defers the legal work to M6; the exposure exists at M0.
2. **Memory is not future work — it's the most-built subsystem in the codebase.** The brief's framing ("look for a user model… is the system prompt static?") assumed a gap that doesn't exist: the prompt is composed at runtime from six memory-derived sections, recall is live per message. The *actual* M3 work is repairing loops the migration severed (hygiene grooming the wrong DB, style-notes producer dead, no delete UI) and adding the missing state (personality, feedback). M3 is cheaper than the brief prices on storage/recall and more expensive on migration debt.
3. **The reranker claim points at the wrong pipeline.** There is no owned web retrieval to rerank — Perplexity does search+read+synthesize opaquely. The reranker's real near-term home is memory recall, where an 8× over-fetch slot already exists. Web reranking is meaningless until an owned search→fetch→chunk→embed pipeline exists — a much bigger decision the strategy doesn't cost.
4. **"Abstraction first" is mis-sequenced — escalation is easy here, consolidation is the chore.** A difficulty router is a one-file change at `aiGateway.mapModel` (the choke point exists; a dead 361-line router even prototypes the policy). What's actually scattered is Perplexity (8 sites). M1 shrinks from a milestone to an opportunistic cleanup.
5. **The strategy is silent on its true prerequisite: finishing the migration.** Voice auth is broken against a placeholder Supabase URL (close 4003), the learning/research loop is dark locally, memory hygiene mutates an abandoned cloud DB, and 12 UI call sites error against the fallback. Claims 4/5 are built on this foundation; migration completion is not housekeeping, it's the critical path's first edge.
6. **Claim 3's ladder has no fuel line, and the strategy doesn't schedule one.** Not one SFT example is being persisted. Logging tuple + one non-approval signal + consent language are cheap, compound with calendar time, and are prerequisites for *both* Atlas-1 and the humour/preference loops — they should start now, years before any fine-tune.
7. **The brief treats signing/updater as an M5 (admin self-dev) concern; it's a shipping concern.** With no signature verification anywhere and sidecars exec'd unchecked, *distribution to a second user* is already unsafe. This work is needed before Atlas leaves the developer's Mac, regardless of when the dev-agent arrives.
8. **One thing the brief gets exactly right, confirmed by code:** memory+personality is the biggest perceived-uniqueness win per unit of effort. The seam (`buildPersonalizedPrompt` + `systemPromptOverride`, shared by text/voice/edge) means personality is a new module, not a restructure — the cheapest milestone on the board relative to its user-visible impact.

---

## 5. Revised critical path

Blind proposal: abstraction → retrieval → memory+personality → Atlas-1 → admin self-dev → global brain.
**Verdict: the memory+personality-first argument survives; the head and tail of the ordering don't.**

1. **P0 — Finish the migration cuts** (voice → CF-token + local DB; learning/research loops → local or explicitly parked; kill the dead Supabase fallback). Everything below stands on this.
2. **P0-parallel — Data capture + legal floor.** Persist the SFT tuple (input, output, tools, system-prompt-at-generation, model id); add one non-approval signal; write real Terms/Privacy; D1 account-deletion endpoint; self-host fonts. Cheap, compounds daily, de-risks the EU exposure that already exists.
3. **M3a — Memory integrity** (UNIQUE upsert, auto-embed on write, forget/delete UI, local consolidation job). Makes "instant, inspectable, deletable" true instead of aspirational.
4. **M3b — Personality module** at the existing seam (`composePersonality(state)` replacing the prose constant, trait bounds, humour gating on the already-detected emotion signal). Biggest visible win.
5. **M1' — Gateway consolidation + difficulty escalation** (fold the 10 raw call sites in; wire routing at `mapModel`; delete or resurrect `providerRouting.ts`). Opportunistic, not a milestone.
6. **M2' — Rerank memory recall** (slot exists); owned web retrieval only if/when research quality demands it.
7. **Ship substrate — signing, notarization, verifying updater, CI on the right branch.** Prerequisite for distribution *and* for M5.
8. **M4 — Atlas-1** once (2) has accumulated data under consent.
9. **M5 — admin self-dev** only after (7); the dev-agent must not precede the enforcement substrate.
10. **M6 — global brain** last, unchanged — and now with the poisoning/opt-in machinery designed before a line of sharing code.

---

## 6. Next 10 PRs

| # | PR | Files |
|---|---|---|
| 1 | Fix CI trigger to `atlas-redesign` (+ commit the untracked `deno.lock` so edge-fn deps are pinned) | `.github/workflows/ci.yml`, `deno.lock` |
| 2 | Persist chat transcripts as SFT tuples: extend `messages` (system/tool roles, model id, system-prompt snapshot) and write from `runChat` | `src-tauri/src/db_schema.sql`, `supabase/functions/_shared/orchestrator.ts`, `services/atlas-brain/src/localDb.ts` |
| 3 | Fix duplicate-fact defect: `UNIQUE(user_id,key)` on `ai_memory` + real ON CONFLICT upsert in the local shim | `src-tauri/src/db_schema.sql`, `services/atlas-brain/src/localDb.ts`, `src-tauri/src/db.rs` |
| 4 | Auto-embed on memory write (call `generateEmbedding`+`upsertVector` inside `memory_store`; keep backfill as repair) | `supabase/functions/_shared/orchestrator.ts`, `services/atlas-brain/src/index.ts` |
| 5 | Forget UI + local erasure: memory browser with per-fact delete + "wipe all my data" against `atlas.db` | `src/components/atlas-health/BrainSearchPanel.tsx` (or new panel), `src/hooks/`, `src-tauri/src/db.rs` |
| 6 | Voice gateway off Supabase: CF-token identity (brain parity) + local DB client for voice turns | `services/voice-gateway/src/index.ts`, `services/voice-gateway/src/session.ts`, `src/hooks/useVoiceSession.ts` |
| 7 | Real Terms + Privacy pages, linked from signup; D1 account+waitlist deletion endpoint | `../atlas-site/` (pages + `functions/api/account/delete.ts`), `src/pages/Auth.tsx` |
| 8 | Self-host fonts in both surfaces (drop `fonts.googleapis.com`); drop Google favicon service for citations | `index.html`, `../atlas-site/index.html`, `src/components/atlas-health/CitationsList.tsx`, `src/components/aria/ConversationPanel.tsx` |
| 9 | `composePersonality(state)` module replacing the hardcoded persona block, with humour gating on the existing emotion detection | new `supabase/functions/_shared/personality.ts`, `supabase/functions/_shared/orchestrator.ts` |
| 10 | Difficulty escalation at the gateway choke point (classifier → `body.model`), retiring `providerRouting.ts` either into use or out of the tree | `supabase/functions/_shared/aiGateway.ts`, `supabase/functions/_shared/orchestrator.ts`, `supabase/functions/_shared/providerRouting.ts` |

(Deliberately excluded: signing/notarization + updater — required, but gated on an Apple Developer account and a release-channel decision, not PR-sized; see critical path step 7. Also worth a 1-liner somewhere: `busy_timeout` on the brain's bun:sqlite connection — two concurrent writers on `atlas.db` today.)

---

## 7. Uncertain / needs human confirmation

- Whether the 36 Supabase edge functions are still deployed/live on the old project, and the **Supabase project region** (EU vs US) — decisive for the transitional mail-metadata analysis.
- Whether `PERPLEXITY_API_KEY` is set in the Keychain (memory notes list five keys, not Perplexity) — without it the live app has **no web retrieval at all**.
- Whether the Gemini key runs on paid terms (no training on inputs) — changes the Art. 28 analysis for the highest-volume personal-data egress. ElevenLabs server-side audio retention is contractual, not visible in code.
- Whether release builds are signed via machine-local tooling outside the repo (in-repo evidence says no); GitHub branch-protection/required-review settings are invisible from the working tree.
- Cargo's 11 `#[test]` fns were not executed (duckdb+librespot compile cost); JS/Bun suites were run: 10 pass locally, `tests/auth.spec.ts` fails 9/12 because it targets the placeholder Supabase URL — dead weight, not a regression signal.
- The SnapTrade/portfolio subsystem (its Keychain credential handling, whether `portfolio.duckdb` is wiped on disconnect, whether holdings feed AI prompts) and `music.rs` credential handling were inventoried but not deep-audited.
- Whether historical conversation data survives in the old Supabase project (import notes say ~empty) — affects whether any training-data backfill exists.
- Schema drift between `supabase/migrations/` (20 files) and `db_schema.sql` was not diffed; the committed sidecar binaries in `src-tauri/binaries/` are artifacts of unknown build provenance.

## 8. Assumptions made

- Atlas is currently distributed to exactly one machine (the developer's); severity of the missing signing/updater chain scales with distribution.
- The strategic position describes *intended* architecture; where the repo contains matching-but-dead code (`providerRouting.ts`) we scored what runs, not what's written.
- "EU" means the operator and target users are EU-established (GDPR applies as controller).
- The gitignored `.env` placeholder (`preview-placeholder.supabase.co`) reflects production desktop builds — i.e., no real Supabase env revives the dark panels. If a real env is present on the user's machine, the voice/learning findings soften from "broken" to "still cloud-coupled."
- ElevenLabs remaining on the critical path for voice is intentional per the brief and was not counted as an offline-viability gap; everything else that breaks offline (chat/embeddings via Gemini, first sign-in via Cloudflare, weather-with-key error propagation) was.
- Read-only mandate honored: no source files were modified; these two report files are the only artifacts.
