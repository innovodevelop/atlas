# Lighthouse Test Lab — engineering plan

**Date:** 2026-08-11 · **Surface:** Lighthouse (admin edition) only ·
**Design:** `docs/design-sync/2026-08-11-prompt-test-lab.md` (Claude Design
produces the visuals first; the stage numbering below builds behind it).

## What it is

A founder picks a feature, launches 1–4 **test agents**, and watches them drive
a **sandboxed copy of Atlas** live: a 2K-class frame stream of each sandbox
window, a narrated action timeline, and a findings rail that fills in real time.
Recordings are saved and replayable; every finding can be packaged into a
coding-agent brief. The real database is never touched.

## Architecture — five components, four of which sit on existing substrate

```
Lighthouse (/test-lab surface)
  │  db:changed / lab events            ┌──────────────────────────────┐
  ├── Rust: lab.rs ────────────────────►│ sandbox #N                   │
  │     · sandbox lifecycle             │  · Atlas webview window      │
  │     · frame capture (SCK)           │  · own data dir + atlas.db   │
  │     · action bridge (eval)          │  · own brain+gateway pair    │
  │     · recording writer              │    on ephemeral ports        │
  └── Brain: /admin/lab/* ──────────────│  · own control-port token    │
        · agent loop (see below)        └──────────────────────────────┘
        · live analysis → findings
```

### 1. The sandbox (`src-tauri/src/lab.rs` + a `--sandbox` launch mode)

The isolation problem is already half-solved by the Lighthouse coexistence work:

- **Data:** `appdata.rs` pins the shared DB slot deliberately. A sandbox sets
  `ATLAS_SANDBOX_DIR`, which `appdata.rs` honours *before* the pinned slot —
  fresh dir per run, holding either a **fixture** DB (seeded demo corpus,
  committed under `src-tauri/fixtures/`) or a **clone** (SQLite backup API
  snapshot of the live DB — never the live file, never WAL-shared).
- **Sidecars:** `instance.rs` runs a claim protocol so exactly one owner binds
  4820/4830. A sandbox must **never claim** — it spawns its own brain+gateway on
  ephemeral ports with `SANDBOX=1`, its own per-launch tokens, pointed at the
  sandbox DB. `SANDBOX=1` in the brain: spend cap enforced, proactive scheduler
  disabled, provider forced to the cheap tier (or mock mode for zero-cost runs).
- **Window:** a second `WebviewWindow` labelled `sandbox-N`, loading the same
  frontend with `?sandbox=N` — `localClient` routes its invokes through
  sandbox-scoped commands. Visibly badged (design brief covers it).
- **Teardown:** window closed, sidecars killed, dir deleted — and a sweep on
  Lighthouse launch removes orphans from crashed runs.

### 2. The action bridge (agent ⇄ sandbox)

The agent needs to *see* and *act*. No WebDriver on WKWebView worth shipping;
instead the bridge is in-process:

- **See:** a `lab_observe(window)` command evaluates a small injected script in
  the sandbox webview that serializes the accessibility tree (role, name, value,
  bounds, `data-screen-label`) plus route + console-error buffer. Same idea as
  the browser tooling this repo is developed with — proven shape.
- **Act:** `lab_act(window, action)` — `click(ref)`, `type(ref, text)`,
  `key(k)`, `navigate(path)`, `wait(ms)` — dispatched via
  `WebviewWindow::eval`, hit-testing the same refs `lab_observe` handed out.
  The action vocabulary is **closed**; the agent cannot eval arbitrary JS.
- Every observe/act pair is journaled to `lab_events` with a monotonic sequence
  number — this *is* the timeline, and it is what syncs to the recording.

### 3. The agent loop (brain: `services/atlas-brain/src/labRoutes.ts`)

Reuses the existing bounded tool-loop machinery (`proactive.ts` is the
precedent for "flat loop, hard containment"):

- Tools: `read_screen`, `act`, `note_finding`, `finish` — nothing else. The
  test agent runs against the **sandbox's** control surface only; it never holds
  the main app's tokens.
- Bounds, all hard: max steps (default 60), wall clock (default 10 min), spend
  cap, and the Rust side kills the sandbox at cap regardless of what the loop
  thinks. `requireUser` on every route, like every other admin route.
- The brief comes from the launcher: surface(s) under test + the founder's
  free-text instruction. The system prompt states the mission is to *test and
  report*, and that the findings schema is the deliverable.
- **Live analysis:** `note_finding` is structured (severity, expectation,
  observation, evidence refs, frame sequence number). A second cheap pass
  de-duplicates and enriches findings at run end. Findings from screen content
  are treated as untrusted text — same injection rules as mail.

### 4. Capture and recording (the one genuinely new native capability)

- **SPIKE (gates this component):** `objc2-screen-capture-kit` — same lockfile
  discipline as ADR 010: prove `cargo add --dry-run` + lock diff is a pure
  append before committing to it. ScreenCaptureKit can capture a single window
  (`SCContentFilter` on the sandbox window) at native resolution.
- **Live stream:** SCK frames at ~10–15 fps, JPEG-encoded, pushed to the
  Lighthouse webview over the existing Tauri event channel (`lab:frame` with a
  shared-buffer path if event payloads prove too slow — measure first).
- **Recording:** full-rate frames to disk per run; v1 stores a frame sequence +
  manifest (seekable by the timeline's sequence numbers), v1.5 muxes to `.mp4`
  via AVAssetWriter (`objc2-av-foundation` — same spike). The recording lives
  under the run's dir, referenced from `lab_runs`.
- **Permission:** Screen Recording TCC — one-time, granted in System Settings.
  The not-granted state is first-class in the design; the plist string lands
  with the code (the ADR 010 lesson: the key ships in the same change).

### 5. The fix-agent handoff

A finding becomes a **brief**: markdown with the claim, evidence, repro steps
(the exact `lab_events` slice), frame references, and the sandbox config to
reproduce. v1 writes it to `docs/lab-briefs/<run>-<n>.md` + a `lab_findings`
row with lifecycle `detected → briefed → fixing → fixed → re-verified`
(re-verified = a later run over the same surface passes). Launching the coding
agent itself shells out to headless `claude -p` in the repo — **behind an
explicit per-launch confirmation**, because it is real code-writing on the real
tree; v1 ships the brief + button, the shell-out lands only with that consent
flow.

## Schema (new tables, `db_schema.sql` conventions)

`lab_runs` (id, brief, surfaces json, sandbox_source, agents, budget json,
status, started_at, ended_at, spend) · `lab_agents` (run_id, ordinal, sandbox
dir, ports, status) · `lab_events` (run_id, agent, seq, kind, payload json,
at) · `lab_findings` (run_id, agent, severity, claim, evidence json, frame_seq,
state, dismissed) · `lab_recordings` (run_id, agent, path, frames, fps, bytes).
JSON columns join `JSON_COLUMNS` in `localClient.ts`; booleans `BOOL_COLUMNS`.
Distinct from the existing `atlas_test_*` tables (the CI runner) — different
lifecycle, do not conflate.

## Stages (each shippable, riskiest first)

| # | Stage | Proves |
|---|---|---|
| L0 | **Spike: SCK + AVFoundation lockfile resolution** (ADR-style) | capture is buildable without moving the vergen pin |
| L1 | Sandbox lifecycle: spawn/teardown one sandboxed Atlas (dir, DB fixture, sidecar pair, window) | isolation — live DB provably untouched |
| L2 | Action bridge: observe + closed action vocabulary + event journal | an agent *could* drive it |
| L3 | Agent loop in brain, findings schema, bounds | one agent completes a scripted mission |
| L4 | Capture: live frame stream to Lighthouse + saved frame recording | the stage renders |
| L5 | `/test-lab` surface per the design handoff (home, launcher, live stage, report) | the product exists |
| L6 | Multi-agent (2–4 sandboxes), shared findings rail | parallel runs don't interfere |
| L7 | Fix-agent briefs + lifecycle; re-verification pass | the loop closes |
| L8 | mp4 muxing, dismissal memory, budget polish | v1.5 |

## Verification

- L1: run with the live app open — hash the live `atlas.db` before/after a
  sandbox run; byte-identical. Orphan sweep tested by SIGKILLing mid-run.
- L2: golden test — scripted action list replays deterministically against the
  fixture DB and produces an identical event journal.
- L3: containment tests in the `proactive.ts` style — step cap, wall clock,
  spend cap each independently kill a runaway loop.
- L4: measured fps + frame latency logged per run; permission-denied path
  exercised by revoking Screen Recording.
- End-to-end: a seeded run over the Auth surface must find a deliberately
  planted defect (a broken fixture flow) and produce a brief for it.
- Every stage: the standard gates (build, 404+ tests, eslint, cargo test).
