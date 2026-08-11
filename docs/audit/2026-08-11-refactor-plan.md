# Atlas refactoring & architecture-optimization plan

**Date:** 2026-08-11 · **Inputs:** `2026-08-11-findings.md` (14 confirmed, 22
plausible, 10 critic gaps) · **Companion:** `2026-08-11-test-lab-plan.md`
(builds on the architecture this plan produces).

**The standing rule for every wave:** the tree is never red. Each wave ends
with `bun run build` clean, the full test suite ≥ its previous count with 0
failures, `bunx eslint src` at 0 errors, `cargo test` green — and one
reviewable commit per wave. Deliberate slow paths (approvals, consent, honest
empty states) and the non-negotiables in the pre-analysis are out of bounds.

---

## Wave 1 — Verified fixes and safe deletions

*Everything here is either adversarially confirmed or mechanically verifiable
before deletion. This is the "stop the bleeding" wave.*

**R1 · The voice-lifecycle cluster (C1–C4 + hardening).**
Cancel the reconnect timer on unmount and guard `connect()` with a
cancelled flag (`useVoiceSession`); disconnect the scribe socket on unmount
(`useRealtimeScribeStable`, copying `useLoginVoice`'s own fix and comment);
release ONNX sessions in `WakeWordDetector.destroy()`; release the Silero VAD
engine in `VoiceSession.destroy()` (gateway). While in the gateway: constant-
time token compare (match the control port) and reject requests bearing an
`Origin` not from the app. **Verification:** a new unmount-leak test harness
(see R5) plus manual: navigate Home↔Dashboard ×5, assert one live WS.

**R2 · The redundant-fetch cluster (C6–C8, +authClient race).**
One module-scoped store per data domain (the `useSyncExternalStore` pattern
`useMusicPlayer` already uses): N mounted consumers share one fetch + one
activity-gated interval. Port `useWeather`, `useStocks`, `useNews` first (they
hit rate-limited external APIs), then `useTasks`/`useCalendarEvents`/
`useMailIntelligence`'s plain refresh. `refreshEntitlement()` gets a
module-level in-flight promise (fixes both the 26-consumer fan-out and the
concurrent-write race in one move). **Verification:** count outbound requests
on dashboard mount before/after (network log): weather 10 → 2.

**R3 · Bundle diet (C9–C10 + dead deps).**
Lazy-split onnxruntime out of the main chunk (dynamic import at wake-word
init; keep `getActiveWakePhrases` eager — it's a string list). Swap the
25.6 MB threaded+JSEP ort wasm for the single-threaded SIMD build and verify
the detector still initializes in the packaged app. Delete, after
verifying zero importers each: the 12 unimported shadcn wrappers + their npm
packages, `@supabase/supabase-js`, `supabase` CLI, `postgres`, and any other
dep `rg` proves unreferenced. **Verification:** main chunk < 700 KB (from
1.11 MB); `bun install --frozen-lockfile` + full gates; wake word exercised in
the packaged app before this ships in a release.

**R4 · Dead-code and dead-claim removals (C11, C13 + plausibles).**
Delete `PersistQueryClientProvider`/persister/allowlist (it persists nothing;
re-introduce only if R6 puts hooks on react-query). Delete the orchestrator's
dead knowledge-extraction trigger (C13) and add an expiry sweep for orphaned
`active` learning sessions. Delete `useRealtimePauseOnInactivity` (pauses a
socket that no longer exists), `learningGuards.isDuplicateTopic` (dead, and
calls a shim method that was never implemented), the stale eslint override
path. Rust: resolve the `ErrCode::Forbidden/TooLarge` dead variants and the
never-read `Ctx.request_id` (wire request_id into audit rows — its evident
purpose — rather than deleting, if cheap). **Verification:** every deletion
preceded by an rg-proof of zero references, quoted in the commit message.

**R5 · The test the suite was missing.**
A mount/unmount harness asserting: after unmount, no pending timers, no OPEN
sockets, no live AudioContext. All five lifecycle leaks were invisible to the
existing 404 tests — this is the class fix, applied first to the voice hooks
(guarding R1 against regression), then available to every hook.

**R6 · Small duplications (plausibles, verify-then-fix).**
`isTyping()` → `atlasHelpers` (5 call sites); one `WATCHLIST` constant; one
`CITIES`/`cityTimes` module with an activity-gated interval; extend the
mail-alert dedup pattern to the plain refresh; `session_context` expiry sweep;
provider-health keyed off the real provider name instead of the literal
`"lovable_ai"`.

**R7 · The vacuous CI gate (critic #4).**
Make the edge-functions job check `_shared/` for real (`deno check` it, or
retire the job and fold a typecheck into the bun gate). A gate that passes
while checking nothing is worse than no gate — it's the third instance of that
defect class this repo has produced (the no-op typecheck, the unenforced
keypair invariant, now this).

---

## Wave 2 — Architecture streamline

*The "add a feature without friction" goal, built on Wave 1's cleaned floor.*

**R8 · One data convention, written down.** After R2, the module-scoped store
is THE pattern: document it in CLAUDE.md (store shape, activity gating,
`db:changed` subscription, error surface), and collapse `useDataFetching`'s
parallel stack into it. Definition of done: a new data hook is one file
following one documented shape.

**R9 · The feature scaffolder.** `bun run new:surface <name>` generates the
page skeleton (surface export, band header, Esc handling, Empty states), the
`surfaces.ts` entry + loader line, the icon entry, the per-surface CSS with
its banner, and bumps the two pinned test counts — the whole 4-file dance the
registry currently requires by hand. The pinned tests stay (they are the
enforcement); the scaffolder removes the friction of satisfying them.
Similarly `new:op` prints the 5-table checklist for a control-port op with
file:line targets. This is the concrete deliverable behind "connect new
features to the Atlas system with ease".

**R10 · Split `runChat()` (C14).** Three units with explicit seams —
`buildTurnContext` (DB fan-out + prompt assembly), `runToolLoop` (bounded
loop), `streamAndCapture` (SSE + turn capture) — pure-function seams so each
gets its own tests. No behavior change; byte-identical prompts asserted by a
golden test before/after.

**R11 · Type-safety ratchet.** `strict` stays off globally (296 files won't
convert in a wave), but: `strictNullChecks` on for `src/lib/` and
`src/hooks/` via project references or per-dir tsconfig, `no-unused-vars` on
for new files, and the ratchet documented — every wave moves the boundary,
none moves it back.

**R12 · Dashboard from the registry (task #52).** The hardcoded grid becomes
registry-driven with a persisted, user-owned arrangement — which is also the
substrate for Atlas rearranging its own dashboard (control-port `Write` op,
bounded vocabulary) and for the Test Lab's fixture dashboards. Big; last in
the wave; the registry's `built:false` discipline already prevents fabricated
cards.

**R13 · The IPC/tier diff (critic #2).** Enumerate all 26 webview-reachable
commands against the control registry's tiers; for each, either document why
webview reach is fine (user-initiated UI action) or route it through the same
policy object. Deliverable: a table in `docs/decisions/` + any closed gaps.

---

## Wave 3 — Runtime truth

*The critic's core point: everything so far is static. This wave executes.*

- **V1** Reproduce #48 (blank window after idle): instrumented idle session,
  Console.app capture of a WebContent jetsam, then the fix.
- **V2** Memory/leak measurement before-and-after Wave 1 (Activity Monitor
  sampling protocol, written down so it's repeatable).
- **V3** #38: one integration test binding a real port and driving
  `handle()` end to end (the 560 unit tests' missing complement).
- **V4** Ship-path drill: signed-or-unsigned artifact through
  `codesign`/`spctl`/updater-upgrade on a scratch machine account.
- **V5** URL-opener scheme allowlist (`https:`/`mailto:` only) at the one
  `openExternal` choke point.
- **V6** Schema-drift check: script diffing brain + localClient table/column
  usage against `db_schema.sql`; `user_version` stamp added.
- **V7** Locale policy: one decision, applied to the 18 bare `toLocale*`
  sites.
- **V8** CSS coverage measurement → split `workshop.css` along the
  per-surface convention that already exists for 15 files.
- **V9** Two-writer drill: Atlas + Lighthouse live simultaneously, the
  documented invariants observed for real.

---

## Running multiple coding agents without conflict

The implementation protocol for every wave, sized from this session's evidence:

1. **File-disjoint assignments.** Each agent owns an explicit file list; no
   two lists intersect. Shared/contended files (`package.json`, `surfaces.ts`,
   `CLAUDE.md`, `localClient.ts` registries) are **never assigned** — the
   integrator (the driving session) edits those after the fan-in.
2. **Agents never run git.** They edit and report; the integrator reviews
   diffs, runs the full gates once per wave, and commits with the wave as one
   reviewable unit. (Two separate incidents this session — the 01:20 cloud
   run and the workflow-killed `home/` module — both trace to agents owning
   git state.)
3. **Gates centrally, not per-agent.** Agents run only the checks local to
   their files (a single test file, eslint on touched paths). The full suite
   is the integrator's job, once, after fan-in — cheaper and catches
   cross-agent breakage the agents can't see.
4. **Verification agents are separate from implementation agents** and get
   refutation briefs, not confirmation briefs (the audit's 14/14 with caught
   fabrications shows this works).
5. **Worktree isolation only when lists must overlap** (rare; costs setup and
   merge). Disjointness is cheaper than merging.
6. **Model routing:** Opus for lifecycle/concurrency/security edits where a
   subtle mistake ships a new leak; Sonnet for verified deletions, mechanical
   ports of an established pattern, and all verification passes. (Fast mode is
   a session-level toggle — it cannot be set per subagent; the cost lever that
   is per-agent is the model choice.)

## Sequencing & status

| Order | Item | Status |
|---|---|---|
| 1 | Wave 1 (R1–R7) | **starting now** — one workflow, file-disjoint |
| 2 | Test Lab L0 spike (SCK lockfile) | after Wave 1 commit |
| 3 | Wave 2 (R8–R13) | R8/R9/R10 first; R12 gated on design where visual |
| 4 | Test Lab L1–L5 | gated on the Test Lab design handoff |
| 5 | Wave 3 (V1–V9) | V1/V3/V5 early — they are cheap and real |
