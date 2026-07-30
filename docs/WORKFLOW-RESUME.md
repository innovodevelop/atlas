# Interrupted workflow state — resume notes (2026-07-30)

Both background workflows hit the **weekly usage limit** (resets Jul 31, 04:00
Europe/Copenhagen) partway through. Their *investigation* phases completed and
those results are cached; only the implement/verify tails died. Resuming replays
the finished agents instantly from cache — do NOT re-run them from scratch.

## Resume commands

```
Workflow({scriptPath: "…/workflows/scripts/atlas-bedrock-phases-wf_0085a002-dda.js",
          resumeFromRunId: "wf_0085a002-dda"})

Workflow({scriptPath: "…/workflows/scripts/atlas-supabase-removal-wf_89c735e8-d6a.js",
          resumeFromRunId: "wf_89c735e8-d6a"})
```

Full agent returns: `subagents/workflows/<runId>/journal.jsonl`.

---

## Workflow 1 — Bedrock phases (5/8 agents done)

**DONE:** caching audit, model research, privacy research, caching impl, privacy impl.
**FAILED (limit):** `impl:models`, `verify:gates`, `verify:adversarial`.

### The finding that matters: prompt caching is currently cache-DEFEATING

Verdict from the audit, with the reasoning worth keeping:

- Anthropic renders `tools -> system -> messages`. Two breakpoints exist:
  one on the last **system** block (`claudeAdapter.ts:171`), one on the last
  **function tool** (`claudeAdapter.ts:238`).
- `orchestrator.ts:849-856` appends **recalled memories** onto the *same*
  system string, and `orchestrator.ts:862-865` emits exactly **one** system
  message. So `system[system.length - 1]` — the block carrying the breakpoint —
  is the block whose bytes change every single turn.
- Result: prefix match always fails. `cache_read_input_tokens` is structurally
  **0**, and every turn pays the **1.25× cache-write premium** on the whole
  system prompt. That is *worse than having no breakpoint at all*.
- The tools breakpoint does not rescue it: the tool block measures ~515 tokens,
  below the 1024 (Sonnet) / 4096 (Haiku, Opus) minimum cacheable prefix, so it
  is silently ignored; and the user-visible streaming call
  (`orchestrator.ts:1056-1061`) sends no `tools` at all.

**Fix (two edits, either alone is a no-op):**
1. `orchestrator.ts` — accumulate memories + session context into a separate
   `volatileContext` string and emit it as a **second** system message *after*
   the stable one. Safe: `claudeAdapter.ts:164-167` hoists all system messages
   into the top-level `system` array in order.
2. `claudeAdapter.ts:171` — move the breakpoint off the last block onto the
   last **stable** one (`system[0]` with the two-block layout).

Secondary invalidator to fix while there: `seriousTopic` (`orchestrator.ts:842`,
`personality.ts:132-158`) is derived per-turn and sits near the *top* of the
prompt, so a flip invalidates from byte 0.

### Still to do
- `impl:models` never ran. `bedrockAdapter.ts` already carries the Opus 5 /
  Fable 5 work from an earlier pass (tier env overrides, `assertEeaProfile`,
  Fable double-gated behind `BEDROCK_MODEL_FABLE_5` + `ATLAS_BEDROCK_ALLOW_NON_EEA`).
  Re-verify rather than redo.

---

## Workflow 2 — Supabase removal (4/9 agents done)

**DONE:** all three inventories.
**FAILED:** `plan:removal` (connection dropped), then all removals + verifies (limit).

**Nothing was deleted.** The tree is untouched by this workflow — it died before
the Remove phase. Safe to resume.

### Inventory highlights worth not re-deriving

- `src/integrations/supabase/client.ts` is an 8-line alias re-exporting
  `localClient`. There is **no supabase-js client in `src/` at all**;
  `@supabase/supabase-js` has **zero importers**.
- `src/integrations/supabase/types.ts` (1971 lines) has **zero importers** — dead.
- `src/hooks/useSupabaseQuery.ts` and `useWatchlist.ts` have **zero consumers**.

### Three real bugs the inventory surfaced (independent of the removal)

1. 🔴 **Relational embeds are silently dropped.** The shim ignores the select
   string, so `agent:agents(name)` yields `undefined` with no error — 3 call
   sites (`useAgentRuns`, `useSchedules`, `LiveRunTimeline`); `agent_name` is
   permanently undefined.
2. 🔴 **Non-`eq` filters are dropped on update/delete.** `eqFilterObj()` harvests
   only `eq`, so `.update().neq(...)` sends `filters: {}` and **rewrites every
   row in the table** — `useAtlasProviderStatus` (benign only because the table
   is a singleton; make it explicit).
3. 🟠 **Column projection ignored.** `useMailIntelligence` relies on
   `ACCOUNT_COLUMNS` to keep `encrypted_refresh_token` out of the client; the
   shim returns full rows, so the token lands in React state.

These are live bugs today, not artefacts of the removal. Fix them regardless.
