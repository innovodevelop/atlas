#!/usr/bin/env bash
# Local CI parity runner — mirrors .github/workflows/ci.yml EXACTLY.
#
# Same commands, same order, one section per CI job:
#   frontend        bun install --frozen-lockfile; bunx tsc -b --force;
#                   bunx eslint .; bun run build; bun test tests/ ./src
#   atlas-brain     (services/atlas-brain) bun install --frozen-lockfile;
#                   bunx tsc --noEmit; bun test
#   voice-gateway   (services/voice-gateway) bun install --frozen-lockfile;
#                   bun run fetch-models; bunx tsc --noEmit; VAD smoke
#   edge-functions  deno check --quiet --no-lock over supabase/functions/*/index.ts
#
# Collect-all semantics: every job runs even after a failure; a per-job
# PASS/FAIL table prints at the end and the exit code is non-zero if any
# job failed. Per-step logs land in .ci-logs/ (gitignored-safe, untracked).
#
# NOT covered here: .github/workflows/rust.yml (`cargo test --manifest-path
# src-tauri/Cargo.toml --lib --locked`). It is a separate workflow so it can
# carry a `paths: src-tauri/**` filter, and it is deliberately left out of this
# script — a cold Rust build is ~15 minutes and would make the local gate
# useless as a habit. Run it yourself when you touch src-tauri/.
#
# Usage:  bun run ci          (this script)
#         bun run ci:quick    (eslint + tsc only — the pre-push gate)
#
# NOTE: if you keep ci.yml and this script in sync, keep the commands
# byte-identical — this script IS the local contract for green CI.

set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOGDIR="$ROOT/.ci-logs"
mkdir -p "$LOGDIR"

JOB_NAMES=()
JOB_RESULTS=()
JOB_FAILED_STEPS=()

# run_step <job> <step-name> <workdir> <cmd...>
# Returns the command's exit code; appends output to the job log.
run_step() {
  local job="$1" step="$2" dir="$3"
  shift 3
  local log="$LOGDIR/$job.log"
  echo "── [$job] $step" | tee -a "$log"
  ( cd "$dir" && "$@" ) >>"$log" 2>&1
  local rc=$?
  if [ $rc -ne 0 ]; then
    echo "   FAIL ($step) — see $log" >&2
    tail -n 30 "$log" >&2
  fi
  return $rc
}

record() { # record <job> <pass|FAIL> <failed-steps>
  JOB_NAMES+=("$1"); JOB_RESULTS+=("$2"); JOB_FAILED_STEPS+=("${3:-}")
}

# ── Job: frontend ────────────────────────────────────────────────────────────
job_frontend() {
  local failed=""
  : > "$LOGDIR/frontend.log"
  run_step frontend "bun install --frozen-lockfile" "$ROOT" bun install --frozen-lockfile || failed+="install "
  run_step frontend "Typecheck (tsc -b --force)"    "$ROOT" bunx tsc -b --force            || failed+="typecheck "
  run_step frontend "Lint (eslint .)"               "$ROOT" bunx eslint .                  || failed+="lint "
  run_step frontend "Build (bun run build)"         "$ROOT" bun run build                  || failed+="build "
  run_step frontend "Tests (bun test tests/ ./src)" "$ROOT" bun test tests/ ./src          || failed+="tests "
  [ -z "$failed" ] && record frontend PASS || record frontend FAIL "$failed"
}

# ── Job: atlas-brain ─────────────────────────────────────────────────────────
job_atlas_brain() {
  local d="$ROOT/services/atlas-brain" failed=""
  : > "$LOGDIR/atlas-brain.log"
  run_step atlas-brain "bun install --frozen-lockfile" "$d" bun install --frozen-lockfile || failed+="install "
  run_step atlas-brain "Typecheck (tsc --noEmit)"      "$d" bunx tsc --noEmit             || failed+="typecheck "
  run_step atlas-brain "Tests (bun test)"              "$d" bun test                      || failed+="tests "
  [ -z "$failed" ] && record atlas-brain PASS || record atlas-brain FAIL "$failed"
}

# ── Job: voice-gateway ───────────────────────────────────────────────────────
job_voice_gateway() {
  local d="$ROOT/services/voice-gateway" failed=""
  : > "$LOGDIR/voice-gateway.log"
  run_step voice-gateway "bun install --frozen-lockfile" "$d" bun install --frozen-lockfile || failed+="install "
  run_step voice-gateway "bun run fetch-models"          "$d" bun run fetch-models          || failed+="fetch-models "
  run_step voice-gateway "Typecheck (tsc --noEmit)"      "$d" bunx tsc --noEmit             || failed+="typecheck "
  # VAD smoke — mirrors the CI step: energy fallback is tolerated (warning only).
  run_step voice-gateway "VAD smoke" "$d" bash -c '
    bun run bench/vad-smoke.ts | tee vad.out
    grep -E "engine: silero" vad.out || echo "WARNING: VAD ran on the energy fallback — Silero did not load (tolerated, as on CI)"
  ' || failed+="vad-smoke "
  [ -z "$failed" ] && record voice-gateway PASS || record voice-gateway FAIL "$failed"
}

# ── Job: edge-functions ──────────────────────────────────────────────────────
job_edge_functions() {
  : > "$LOGDIR/edge-functions.log"
  if ! command -v deno >/dev/null 2>&1; then
    echo "deno not installed — cannot run edge-functions job" | tee -a "$LOGDIR/edge-functions.log" >&2
    record edge-functions FAIL "deno-missing"
    return
  fi
  run_step edge-functions "deno check supabase/functions/*/index.ts" "$ROOT/supabase/functions" bash -c '
    fail=0
    for d in */; do
      d="${d%/}"
      [ "$d" = "_shared" ] && continue
      if ! deno check --quiet --no-lock "$d/index.ts"; then
        echo "FAILED type-check: $d"
        fail=1
      fi
    done
    exit $fail
  ' && record edge-functions PASS || record edge-functions FAIL "deno-check"
}

job_frontend
job_atlas_brain
job_voice_gateway
job_edge_functions

# ── Summary ──────────────────────────────────────────────────────────────────
echo
echo "── CI parity summary ─────────────────────────────"
printf "%-16s %-6s %s\n" "JOB" "RESULT" "FAILED STEPS"
exit_code=0
for i in "${!JOB_NAMES[@]}"; do
  printf "%-16s %-6s %s\n" "${JOB_NAMES[$i]}" "${JOB_RESULTS[$i]}" "${JOB_FAILED_STEPS[$i]}"
  [ "${JOB_RESULTS[$i]}" = "FAIL" ] && exit_code=1
done
echo "──────────────────────────────────────────────────"
echo "Logs: $LOGDIR/"
exit $exit_code
