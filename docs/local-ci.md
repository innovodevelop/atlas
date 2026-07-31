# Local CI parity

CI (`.github/workflows/ci.yml`) is mirrored locally so nothing lands red.

## Commands

| Command | What it runs |
|---|---|
| `bun run ci` | Every CI job, same commands, same order (`scripts/ci/run.sh`). Collect-all: all jobs run, a PASS/FAIL table prints at the end, exit is non-zero if any job failed. Per-job logs in `.ci-logs/`. |
| `bun run ci:quick` | The cheap gates only: `eslint .` + `tsc -b --force`. |
| `bun run hooks:install` | Points git at the committed hooks (`git config core.hooksPath scripts/hooks`). |

Jobs mirrored by `bun run ci`: **frontend** (frozen install, `tsc -b --force`,
`eslint .`, `bun run build`, `bun test tests/`), **atlas-brain** (install,
`tsc --noEmit`, `bun test`), **voice-gateway** (install, `fetch-models`,
`tsc --noEmit`, VAD smoke — energy fallback tolerated), **edge-functions**
(`deno check --quiet --no-lock` over `supabase/functions/*/index.ts`,
skipping `_shared`). Requires Bun and Deno on PATH.

## Pre-push hook

`scripts/hooks/pre-push` runs `bun run ci:quick` before every push. It exists
because 61 lint errors accumulated invisibly — nothing ran eslint locally.
Install once per clone with `bun run hooks:install`; bypass deliberately with
`git push --no-verify`.

## Live auth tests

The 9 live tests in `tests/auth.spec.ts` are opt-in:

```bash
RUN_LIVE_AUTH_TESTS=1 bun test tests/auth.spec.ts
```

Without the flag they skip everywhere (they used to run whenever `.env` had
`VITE_SUPABASE_URL`, failing locally against the dead Supabase project). The
static config-discipline tests always run. The live tests are kept because
their targets may move to helloatlas.dk later.

Keep `scripts/ci/run.sh` byte-identical to `ci.yml` when either changes.
