# Atlas full-codebase audit — pre-analysis plan

**Date:** 2026-08-11 · **Scope:** everything that ships — webview, Rust core,
both sidecars, the shared orchestrator, build/CI/dependency surface.
**Output:** `2026-08-11-findings.md` (verified findings) →
`2026-08-11-refactor-plan.md` (the implementation plan).

## Why

Three goals, in the user's words, restated as measurable claims:

1. **Performance.** Atlas must be lightning fast — no friction, no loading
   screens. Concretely: cold-start to painted dashboard, route-change latency,
   main-chunk size, re-render storms, timer/socket hygiene under WKWebView
   throttling, redundant network calls.
2. **Architecture.** Simplify and streamline without losing functionality —
   modular, with a frictionless path for adding a feature and wiring it into the
   Atlas system (surface registry → data hooks → SQLite → control port → domain
   tools). The measure: how many places must be edited, and how many can be
   forgotten silently, to add one feature end to end.
3. **Correctness.** Code errors, half-finished code, dead code, security
   vulnerabilities. The measure: findings that survive adversarial verification.

## The terrain (measured, not guessed)

| Area | Files | Lines |
|---|---|---|
| `src/` (webview) | 296 | 56,436 |
| `src-tauri/src/` (Rust) | 51 | 36,653 |
| `services/atlas-brain/` | 32 | 7,694 |
| `services/voice-gateway/` | 12 | 1,612 |
| `supabase/functions/_shared/` (runtime-neutral orchestrator) | 13 | 4,457 |
| **Total** | **404** | **~106,852** |

Biggest files: `home/companion.rs` 2,161 · `control/registry.rs` 1,914 ·
`control/mod.rs` 1,789 · `orchestrator.ts` 1,673 · `workshop.css` 1,481.
60 runtime npm deps + 17 dev.

## Suspects going in (leads, not conclusions — every one must be verified)

- **P1** The production build warns: the main `index-*.js` chunk is **1.11 MB**
  (337 KB gzip). What is in it, and what should not be?
- **P2** 26 components call `useAuth()`; each mount fires its own
  `refreshEntitlement()` → `/api/me`. One session, dozens of identical calls.
- **P3** The dashboard renders a hardcoded card list; the widget registry is
  descriptive only (open task #52). Cards mount all at once with all hooks live.
- **P4** `workshop.css` is a 1,481-line monolith loaded for every surface, while
  15 per-surface stylesheets also exist — the split is inconsistent.
- **P5** Two intervals tick the world clock in parallel (`AtlasExtraCards`,
  `useCatalogWidgets`); neither is activity-gated. What else polls ungated?
- **A1** Adding one surface today requires edits in ≥4 files with 2 hardcoded
  test counts; adding a control-port op requires 3 parallel tables in
  `orchestrator.ts` plus 2 pinned Rust tables. Which of these duplications are
  load-bearing tests (keep) vs friction (collapse)?
- **A2** Dead dependency surface: `@supabase/supabase-js`, `supabase` CLI,
  `postgres` remain in package.json on no runtime path (CLAUDE.md admits this);
  `@elevenlabs/react` overlaps the native voice-gateway path;
  `useRealtimeScribeStable` duplicates `useLoginVoice`'s connection logic.
- **A3** `agents`/`runs`/`run_steps`/`schedules` tables: a full multi-tier agent
  schema with zero Rust readers. Dead schema or future substrate?
- **C1** Known open defects: #48 (window blanks after idle, Cmd+R won't
  recover), #38 (560 control-port Rust tests never executed against a live
  port), #23 (mail 6b–6d never runtime-verified).
- **C2** Voice hook sprawl: `useVoiceSession` claims to replace five hooks whose
  files still exist. Which are reachable?
- **S1** Injection surface: mail bodies, school content (future), scraped pages
  — all attacker-authorable text entering the model context. The control port's
  tier system defends the desktop; what defends the *webview* (HTML rendering
  of provider mail, dangerouslySetInnerHTML)?
- **S2** Loopback services: control port (hardened, 4-rung ladder), brain
  (sidecar token + decode-only JWT), voice gateway (CORS `*` + optional token).
  Are the three at equivalent strength, and should they be?

## Method

**Eight finder agents** (Sonnet), one per subsystem, each applying all three
lenses to its files — the same reader covers perf, architecture and correctness
in one pass because the expensive part is reading, not judging:

| # | Subsystem | Focus files |
|---|---|---|
| F1 | App shell & data layer | App, AppRoutes, surfaces, queryClient, localClient, authClient, brainClient, hook conventions |
| F2 | Dashboard & rendering | AtlasDashboard, atlas-ui cards/primitives, canvas/sphere renderers, workshop.css, widget catalog |
| F3 | Surfaces | pages/atlas/* + pages/* (mail, smart home, health, music, core, answer views, settings, auth) |
| F4 | Voice chain | useVoiceSession/useStreamingTTS/useLoginVoice/wakeWord, voice-gateway service, audio plumbing |
| F5 | Rust platform | lib.rs, db.rs, scheduler, instance, appdata, secrets, http, datafetch, oauth |
| F6 | Rust domains | control/*, mail.rs, home/*, health/*, music*, portfolio* |
| F7 | Brain + orchestrator | atlas-brain/src/*, supabase/functions/_shared/* |
| F8 | Build & deps | package.json, vite/tsconfig, Cargo.toml features, CI workflows, chunk map, dead deps, test-coverage map |

Every finding is structured: kind (perf / arch / error / security / dead-code),
severity (critical / high / medium / low), file:line, one-sentence claim,
evidence, suggested fix, effort (S/M/L). Rules of engagement: **read-only** —
no edits, no git, no builds beyond what exists; every claim must carry evidence
a verifier can check; "this looks bad" without a failure scenario is not a
finding.

**Dedup in code**, then **adversarial verification**: every critical/high
finding goes to an independent skeptic (Sonnet) whose brief is to REFUTE it —
default to refuted when uncertain. Mediums are spot-checked. Then one
**completeness critic** (Opus, high effort) asks what the sweep structurally
missed.

**Synthesis** (top model, inline in the driving session): findings →
`2026-08-11-refactor-plan.md`, ordered by risk-adjusted value, each item with
its verification gate.

## Non-negotiables the audit must respect

- **NEVER `cargo update`** (vergen 9.0.6 pin). Dependency findings must state
  the lockfile consequence, per the ADR 010 method.
- Local-first privacy commitments: memories, SQLite, embeddings, chat history
  never move to cloud. Any "optimization" that violates this is wrong by
  definition.
- The design system (borderless, tokens, primitives) is not up for review here.
- The tier/approval security model is load-bearing; simplifications must not
  weaken it. Its *duplication* may be collapsed only if the pinned tests remain.
- Deliberate slow paths stay: approval queues, consent screens, honest empty
  states.

## What "done" means for the analysis

Every finding either CONFIRMED (with evidence a second agent checked) or
dropped. A completeness pass has named what was not covered. The refactor plan
sequences fixes so that every stage keeps `bun run build` + 404 tests + eslint
+ `cargo test` green, and names the verification for each item.
