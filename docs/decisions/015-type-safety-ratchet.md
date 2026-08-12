# ADR 015 — Type-safety ratchet: strictNullChecks + no-unused-vars over `src/lib/`

**Status:** accepted · **Date:** 2026-08-12 · **Verdict:** **BOUNDARY ENFORCED — `src/lib/` (minus 2 files), everything wider stays loose**

## Verdict

`tsconfig.app.json` stays `strict: false` — 296 files will not convert in one
wave, and a red tree helps nobody (R11's own framing). Instead, a second,
narrower gate now sits on top of it: `tsconfig.strict.json` turns on
`strictNullChecks` + `noUnusedLocals` over `src/lib/`, and
`eslint.config.js` turns `@typescript-eslint/no-unused-vars` back on for the
same files. Both pass today, clean — zero errors fixed by widening a type to
`any` or adding a non-null assertion, per the rule this task was given.

The enforced `include` is `src/lib/` **minus** `brainClient.ts` and
`voiceClient.ts` (reason below) — not the full directory. Every future wave
widens the boundary outward; none narrows it back.

## Measured counts (evidence, not estimates)

All four runs used `bunx tsc --noEmit` against a throwaway tsconfig with
`strict: false` and only the flag(s) named below flipped to `true`, on top of
today's tree (branch `atlas-redesign`, commit `1b3dd40`). Full command and
output kept in this ADR; the throwaway configs were deleted after measuring —
only `tsconfig.strict.json` is committed.

| Boundary | `strictNullChecks` only | `strictNullChecks` + `noUnusedLocals` |
|---|---|---|
| Whole tree (`src/`, 270 non-test files) | 22 errors, 10 files | 46 errors |
| `src/hooks/` alone (transitive closure) | — | 11 errors (9 in hooks, 2 inherited) |
| `src/lib/` alone (transitive closure) | — | 2 errors, **both inherited, 0 owned** |
| `src/lib/` minus `brainClient.ts`, `voiceClient.ts` | — | **0 errors** |

Whole-tree breakdown (`strictNullChecks` only, 22 errors): `AtlasCards.tsx`
(2), `AtlasExpanded.tsx` (2), `ClayBody.tsx` (6), `MusicCoverCard.tsx` (1),
`MusicPlayerFull.tsx` (1), `AtlasHealth.tsx` (4), `useBandNarration.ts` (1),
`src/hooks/useHealth.ts` (2), `src/hooks/useMailIntelligence.ts` (1),
`src/integrations/local/localClient.ts` (2). None of these are inside
`src/lib/`.

`src/hooks/` breakdown (11 errors): four `TS6133` unused-var errors
(`useAtlasLearning.ts` ×3, `useAtlasProviderStatus.ts` ×1) plus two more
(`useCrudOperations.ts`, `useTasks.ts`) — six total unused-var; `useHealth.ts`
×2 and `useMailIntelligence.ts` ×1 are real `strictNullChecks` hits (`string |
null` passed where `string` is required, and a possibly-`null` value read
unchecked); the remaining 2 are `localClient.ts`, pulled in transitively.
`src/hooks/` is **not** enforced this wave — it is 9 real fixes away from
clean and out of this task's file-ownership list (`src/hooks/` edits were not
authorized here). Left for the next wave.

`src/lib/` itself has **zero** owned errors under either flag — confirming
the task brief's guess that it's the newest, most-tested code. The only
errors reachable from `src/lib/` are two `TS2352` casts inside
`src/integrations/local/localClient.ts` (`… as null`, lines 33 and 42), pulled
into the program because `brainClient.ts` and `voiceClient.ts` both `import {
isTauri } from "@/integrations/local/localClient"`. TypeScript type-checks a
file's full transitive import closure regardless of `tsconfig`'s `exclude` —
excluding `localClient.ts` itself does not remove it from the program once
anything included imports it.

`localClient.ts` is off-limits to edit (CLAUDE.md, and this task's rules
name it explicitly). The two options were: silence the two casts with a
non-null assertion or a `strictNullChecks`-defeating `any` (forbidden by this
task), or exclude the two files whose only fault is importing it. The second
is the honest trade the task asked for — *"a smaller enforced boundary is
worth more than a larger one bought with assertions."* `tsconfig.strict.json`
documents this inline, at the point of the `exclude` entries, with the exact
line numbers and the reason, so it reads as a decision and not a silent gap —
drop the exclusion the moment `localClient.ts` is back in scope for an edit.

## The ratchet rule

1. The boundary only ever grows. `tsconfig.strict.json`'s `include` today is
   `src/lib/**/*.ts` (plus `src/vite-env.d.ts` for `ImportMeta.env` typing);
   the next wave adds a directory or file to it, never removes one — except
   the two-file carve-out above, which is expected to shrink to zero, not
   grow.
2. A file only enters the boundary once it passes with **zero** widened types
   and **zero** added non-null assertions. If a fix isn't obviously correct,
   it stays out and gets reported, per this task's rule.
3. `eslint.config.js`'s `no-unused-vars` override tracks the same `files`
   glob as the tsconfig boundary — the two move together, not independently.
4. `tsconfig.app.json` (the real build/typecheck gate) does not change until
   its own boundary — eventually all of `src` — is what `tsconfig.strict.json`
   already enforces piece by piece. At that point `tsconfig.strict.json`
   itself retires into `tsconfig.app.json` and this ADR's job is done.

## Exact command to check

```bash
bunx tsc -p tsconfig.strict.json --noEmit
bunx eslint 'src/lib/**/*.{ts,tsx}'
```

Both currently exit 0. The integrator should wire the first into
`package.json` as a new script — **not edited here** (out of this task's file
ownership; `package.json` is explicitly forbidden):

```json
"typecheck:strict": "tsc -p tsconfig.strict.json --noEmit"
```

`bun run typecheck:strict` then becomes the CI-callable form. The eslint
override needs no new script — it's already inside the existing `lint` run's
scope (`eslint .`), just enforced only for the files the new `files` glob
matches.

## Would this have caught the 59 errors from task #15?

**No — different files, different failure mode.** Task #15 (commit `283b9a9`)
was `build` silently no longer invoking `tsc -b --force` at all before `vite
build`; the existing whole-tree gate had the right flags for a `strict: false`
tree (`build` doesn't enable `strictNullChecks` even today) but simply never
*ran*, so 59 errors accumulated undetected — mostly in `ErrorLogStream`,
`LiveRunTimeline`, `useAtlasProviderStatus`, and other hooks/components
outside `src/lib/`, from the local Supabase realtime shim delivering
`payload.new === null` unchecked.

This ADR's gate is additive strictness on a narrow, already-clean directory —
it answers "is `strict: false` hiding real bugs in the code we trust most,"
not "does the typecheck script actually run." It would not have caught #15
for two independent reasons: the boundary (`src/lib/`) doesn't include any of
the files #15 touched, and the defect class is different — an unexecuted
gate, not an under-configured one. The gate that *would* generalize to #15 is
the one task #15 itself restored (the `build` script actually running `tsc -b
--force`) plus Wave 1's CI-gate fix (ADR 013) for the same "plausible name,
checks nothing" shape elsewhere. What this ratchet buys instead: `useHealth.ts`
and `useMailIntelligence.ts` (2 + 1 = 3 of the 11 `src/hooks/` errors measured
above) are the *same defect shape* as #15 — unchecked-`null` reads — sitting
undetected today because `strict: false` masks them even though the gate
that would catch them runs on every commit. That's the gap this ratchet is
built to close, one boundary at a time.

## Where this is recorded

- `tsconfig.strict.json` (new) — the enforced boundary, with the two-file
  exclusion reasoned inline.
- `eslint.config.js` — new `files: ["src/lib/**/*.{ts,tsx}"]` override
  re-enabling `@typescript-eslint/no-unused-vars`, with an
  `argsIgnorePattern: "^_"` for the three existing mock/fake params
  (`atlasSphere.test.ts`, `reconnectGovernor.test.ts`, `sharedStore.test.ts`)
  that must match an interface shape but never read the arg.
- This file — measured counts, the boundary, the ratchet rule, the command.

## Not determined / left for the integrator

- **`package.json`** needs the `typecheck:strict` script above — not added
  here, `package.json` is forbidden to this task.
- **CI wiring** (`.github/workflows/ci.yml`, `scripts/ci/run.sh`) needs a step
  calling `bun run typecheck:strict` so this gate actually runs on every push,
  the same lesson ADR 013 already drew about gates that exist but aren't
  invoked. Not touched here — outside this task's file ownership.
- **`src/hooks/`** is the obvious next boundary (11 measured errors, 9 of them
  real and owned by hooks) — not fixed here, `src/hooks/` edits were not
  authorized for this task.
- **`localClient.ts`**'s two `TS2352` casts are real and would need a real
  fix (not an assertion) before `brainClient.ts`/`voiceClient.ts` can rejoin
  the boundary — flagged, not fixed, since the file is off-limits here.
