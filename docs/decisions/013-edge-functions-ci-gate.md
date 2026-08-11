# ADR 013 — The `edge-functions` CI gate checked nothing

**Status:** accepted · **Date:** 2026-08-11 · **Verdict:** **CONFIRMED VACUOUS**

## Verdict

**CONFIRMED.** The completeness critic's claim is correct and reproduces
exactly as described. `supabase/functions/` contains only `_shared/` — every
other edge function was deleted during the local-first migration (CLAUDE.md's
"Inert leftovers" note) — so the job's `for d in */` loop, which explicitly
skips `_shared`, iterates **zero directories**, runs `deno check` zero times,
and exits 0. It has passed on every commit since the functions it was written
to check were removed, without ever type-checking a single file.

This is the third instance of "a gate that passes while checking nothing" in
this repo's history, per `docs/audit/2026-08-11-refactor-plan.md` (R7): the
no-op frontend typecheck (task #15, below), the unenforced updater-keypair
invariant, and now this.

## Evidence

`ls supabase/functions/` — the premise the loop depends on:

```
$ ls -la supabase/functions/
total 0
drwxr-xr-x@  3 magnuspilegaard  staff   96 Jul 31 10:03 .
drwxr-xr-x@  6 magnuspilegaard  staff  192 Jul 20 23:43 ..
drwxr-xr-x@ 15 magnuspilegaard  staff  480 Aug 11 19:46 _shared
```

Running the **exact loop body** from the original `edge-functions` job, verbatim, in
`supabase/functions/`:

```
$ fail=0
$ for d in */; do
    d="${d%/}"
    [ "$d" = "_shared" ] && continue
    if ! deno check --quiet --no-lock "$d/index.ts"; then
      echo "FAILED type-check: $d"
      fail=1
    fi
  done
$ echo "job exit code: $fail"
job exit code: 0
```

The loop body never printed a single "would check" line — `_shared` is the only
entry, and it is the one name explicitly excluded.

**Decisive proof it is vacuous, not just currently clean:** a live type error was
injected into `supabase/functions/_shared/auth.ts` (`const x: number = "not a
number"`) and the same loop was run again over the file with the error still in
the tree:

```
$ deno check --quiet --no-lock _shared/auth.ts
TS2322 [ERROR]: Type 'string' is not assignable to type 'number'.
const __adr013ProofOfLife: number = "not a number";
      ~~~~~~~~~~~~~~~~~~~
    at .../supabase/functions/_shared/auth.ts:11:7
error: Type checking failed.
$ echo $?
1                                    # deno itself catches it, directly

$ fail=0
$ for d in */; do
    d="${d%/}"; [ "$d" = "_shared" ] && continue
    if ! deno check --quiet --no-lock "$d/index.ts"; then
      echo "❌ $d failed type-check"; fail=1
    fi
  done
$ echo "job exit code: $fail"
job exit code: 0            # PASS, with a live TS2322 sitting in the tree
```

`deno check` catches the error the instant it is pointed at the file directly.
The CI job never points it at the file at all. The error was reverted
immediately after this test; `git status` confirms zero residual diff in
`supabase/functions/_shared/`.

## Why it went unnoticed

`_shared/` is not dead — it is 4,457 lines of runtime-neutral TypeScript
(`aiGateway.ts`, `orchestrator.ts`, `bedrockAdapter.ts`, `claudeAdapter.ts`,
`awsSigV4.ts`, `providerRouting.ts`, `providerStatus.ts`, `learningGuards.ts`,
`personality.ts`, plus four dead files below) that `services/atlas-brain/src/`
re-imports directly (`src/index.ts`: *"re-imports the SAME runtime-neutral
`_shared/orchestrator.ts` the voice..."*). So every push still ran a job named
"Edge functions" that appeared to guard this code, and the brain's own
`tsc --noEmit` job was quietly doing **some** of the real work by accident —
see the next section. Green CI on a job with a plausible name, covering code
that visibly still matters, is exactly the condition under which nobody
double-checks the loop it runs.

## An important nuance the initial framing didn't have: partial accidental coverage

Before changing anything, the natural question was checked empirically: does
`services/atlas-brain`'s own `bunx tsc --noEmit` — which was never vacuous —
already catch errors in `_shared/` files, just by following the `import`
statements from `src/*.ts`? TypeScript's `include` only seeds the root file
set; anything reached transitively through an import is still added to the
program and type-checked.

Proof, using `providerStatus.ts` — a file `services/atlas-brain/src/*.ts` never
imports directly, only two hops away via `orchestrator.ts` → `learningGuards.ts`
→ `providerStatus.ts`:

```
$ cd services/atlas-brain && bunx tsc --noEmit
$ echo $?
0
# inject `const x: number = "not a number";` into ../../supabase/functions/_shared/providerStatus.ts
$ bunx tsc --noEmit
../../supabase/functions/_shared/providerStatus.ts(5,7): error TS2322: Type 'string' is not assignable to type 'number'.
$ echo $?
2
```

So the existing `atlas-brain` typecheck job already caught this — by accident,
as a side effect of what `src/index.ts`, `mailDraft.ts`, `greeting.ts`,
`learningRoutes.ts`, `proactive.ts` and `localDb.ts` happen to import today.
That accidental coverage reaches 9 of the 13 files in `_shared/`. It is real,
but it is not a **guarantee** — refactor an import away (as is actively
happening elsewhere in this same audit wave) and a file silently drops out of
CI with no signal, which is the same failure shape as the vacuous loop, just
with better odds today.

The other 4 files — `auth.ts`, `cors.ts`, `crypto.ts`, `mailShared.ts` — are
**not** reached by any import, from the brain or from anywhere else:

```
$ rg -l '_shared/auth' --type ts     # (repo-wide, excluding node_modules)
$ rg -l '_shared/mailShared' --type ts
$ rg -l '_shared/cors' --type ts
$ rg -l '_shared/crypto' --type ts
supabase/functions/_shared/mailShared.ts   # only mailShared.ts imports crypto.ts, and mailShared.ts itself is unimported
```

All four are dead Supabase-edge-function code left behind when the functions
that used them were deleted — the same class CLAUDE.md already calls out as
"Inert leftovers." `auth.ts` also imports a Deno-only remote URL specifier
(`https://esm.sh/@supabase/supabase-js@2.39.0`), which cannot resolve under
`bunx tsc` regardless of reachability — further confirmation it has never run
under the brain and was never a candidate for "typecheck it where it actually
runs."

## The fix

Retired the `edge-functions` job. Added a step to the existing `atlas-brain`
job in `.github/workflows/ci.yml` — "Typecheck supabase/functions/_shared
(this sidecar's real import surface)" — that:

1. Generates a barrel file (`services/atlas-brain/scripts/.ci-shared-typecheck.generated.ts`,
   never committed) that imports every `supabase/functions/_shared/*.ts` file
   **except** the four dead ones above, named explicitly with the reasoning
   in a code comment rather than silently omitted.
2. Runs the same `bunx tsc --noEmit` the job already runs — dropping the
   barrel in `scripts/` is sufficient, since
   `services/atlas-brain/tsconfig.json` already includes `"scripts/**/*.ts"`.
   No tsconfig or package.json edit, both of which are out of scope for this
   change (owned elsewhere per the refactor plan).
3. Deletes the barrel.

This makes the accidental 9-file coverage found above **explicit and
import-graph-proof** instead of a side effect of the current call graph, and
gives the 4 dead files a real, documented decision instead of a silent skip.
`scripts/ci/run.sh` mirrors the same three steps in `job_atlas_brain()`
byte-for-byte-equivalent to the CI step, per the parity rule stated at the top
of that script — with one addition the developer-machine context requires: a
defensive `rm -f` before generating the barrel and an unconditional one after,
since this script runs against a real working tree, not a disposable runner.

## Proof the new gate fails, and then passes

Two separate files were used, both reachable only through the generated
barrel (not directly imported by any `src/*.ts` file in the brain):

**`providerRouting.ts`** — `const __adr013ProofOfLife: number = "not a number";`
added after the `ModelTier` export:

```
$ cd services/atlas-brain && bunx tsc --noEmit    # (barrel present)
../../supabase/functions/_shared/providerRouting.ts(11,7): error TS2322: Type 'string' is not assignable to type 'number'.
$ echo $?
2
```

Reverted, re-run:

```
$ bunx tsc --noEmit
$ echo $?
0
```

**`personality.ts`** — same injected line, ahead of the `Traits` interface, run
through the literal `generate_shared_typecheck_barrel()` function now
committed in `scripts/ci/run.sh` (not a hand-rolled equivalent):

```
$ source <(sed -n '/^generate_shared_typecheck_barrel() {/,/^}/p' scripts/ci/run.sh)
$ generate_shared_typecheck_barrel "$PWD/services/atlas-brain"
$ cat services/atlas-brain/scripts/.ci-shared-typecheck.generated.ts
// AUTO-GENERATED by scripts/ci/run.sh (job_atlas_brain). Not committed; deleted at the end of this job.
import "../../../supabase/functions/_shared/aiGateway.ts";
import "../../../supabase/functions/_shared/awsSigV4.ts";
import "../../../supabase/functions/_shared/bedrockAdapter.ts";
import "../../../supabase/functions/_shared/claudeAdapter.ts";
import "../../../supabase/functions/_shared/learningGuards.ts";
import "../../../supabase/functions/_shared/orchestrator.ts";
import "../../../supabase/functions/_shared/personality.ts";
import "../../../supabase/functions/_shared/providerRouting.ts";
import "../../../supabase/functions/_shared/providerStatus.ts";

$ (cd services/atlas-brain && bunx tsc --noEmit)     # baseline, no error yet
$ echo $?
0

# inject the error into personality.ts, then:
$ (cd services/atlas-brain && bunx tsc --noEmit)
../../supabase/functions/_shared/personality.ts(18,7): error TS2322: Type 'string' is not assignable to type 'number'.
$ echo $?
2

# reverted:
$ (cd services/atlas-brain && bunx tsc --noEmit)
$ echo $?
0
```

Both injected lines were removed immediately after each proof; `git status`
was checked after every round and showed zero residual diff outside this
change's own three files.

## Would this have caught the 59 errors from task #15?

**No — different code, different gate, already fixed independently.** Task
#15 ("Fix the 59 type errors hidden by the no-op typecheck gate," commit
`283b9a9`, *"Zero type errors, Atlas wake phrases, and the free
download-size wins"*) was a **frontend** gate: `build` had silently stopped
running `tsc -b --force` ahead of `vite build`, so 59 errors accumulated in
`src/` — mostly the local Supabase realtime shim always delivering
`payload.new === null`, which several hooks (`ErrorLogStream`,
`LiveRunTimeline`, `useAtlasProviderStatus`, …) dereferenced unchecked. That
gate was already restored in that commit and is unrelated to
`supabase/functions/`; this ADR's fix does not touch it and would not have
caught those 59 errors, because they were never in `_shared/` to begin with.
What this ADR's fix **does** share with that incident is the defect
*class* — a CI step whose name promised coverage it did not provide — which is
the throughline the refactor plan (R7) calls out across all three instances.

## Where this is recorded

- `.github/workflows/ci.yml` — the retired `edge-functions` job (replaced by
  a step in `atlas-brain`) and the new step itself, commented at the point of
  change with this ADR's number.
- `scripts/ci/run.sh` — `job_atlas_brain()` and the new
  `generate_shared_typecheck_barrel()` helper, kept byte-identical in
  substance to the CI step per the file's own parity rule.
- `docs/local-ci.md` — describes the old `edge-functions` job by name and
  will read stale once this lands; out of this change's file ownership, so
  flagged for the integrator rather than edited here.

## Not determined / left for the integrator

- **`docs/local-ci.md`** still documents the retired `edge-functions` job and
  needs its job table updated to describe the new `atlas-brain` step instead.
  Not edited here — outside this change's owned file list.
- **The 4 excluded dead files** (`auth.ts`, `cors.ts`, `crypto.ts`,
  `mailShared.ts`) are not typechecked by anything, anywhere, now. That is the
  honest, documented state of dead code with no runtime path — not a gap in
  this fix — but deleting them outright (rather than leaving them excluded and
  unchecked) is a reasonable follow-up and is explicitly out of scope for a
  CI-only change.
- This ADR does not audit whether any *other* CI job has the same "plausible
  name, checks nothing" shape. The refactor plan names two other instances
  historically (no-op frontend typecheck, unenforced updater-keypair
  invariant); neither was re-verified as part of this change.
