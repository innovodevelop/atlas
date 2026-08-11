# Wave 1b — dead shadcn components + oversized ONNX wasm

**Scope:** `src/components/ui/` (deletions only), `public/ort/`, wasm/model
provisioning scripts under `scripts/` (excluding `scripts/ci/`). Implements
findings C10 (25.6 MB threaded+JSEP wasm shipped for single-threaded code) and
the plausible "12 shadcn components, zero importers" item from
`2026-08-11-findings.json`.

Note: the main-chunk win from splitting `wakeWordRuntime.ts` out of the eager
import graph (finding C9, 1113 → 707 kB) already landed in Wave 1a
(commit `d2aa5af`) and is **not** part of the numbers below — this wave is
static-asset weight only (`src/components/ui/` deletions + `public/ort/`).

## 1. Dead shadcn wrapper components — deleted

The audit's finder claimed 12 wrapper files under `src/components/ui/` have
zero importers. Verified individually rather than trusting the finder: for
every file in the directory ran
`rg -l "components/ui/<name>" src/ services/ scripts/ docs/ tests/ index.html vite.config.ts tailwind.config.ts components.json`
and excluded the file's own definition. Three files the audit did *not* flag
as at-risk were checked with the same method and confirmed live, so they were
left alone: `toaster.tsx`, `sonner.tsx` (both wired in `src/App.tsx`) and
`tooltip.tsx` (`src/App.tsx` + `src/components/ui/sidebar.tsx`).

All 12 candidates came back with zero importers anywhere outside their own
file — deleted:

| File deleted | npm package(s) orphaned | Proof (0 other importers of the package) |
|---|---|---|
| `input-otp.tsx` | `input-otp` | only `import { OTPInput, OTPInputContext } from "input-otp"` in the deleted file |
| `carousel.tsx` | `embla-carousel-react` | only import site was the deleted file |
| `calendar.tsx` | `react-day-picker` | only import site was the deleted file |
| `drawer.tsx` | `vaul` | only import site was the deleted file |
| `resizable.tsx` | `react-resizable-panels` | only import site was the deleted file |
| `command.tsx` | `cmdk` | only import site was the deleted file. (Also imported `@radix-ui/react-dialog` — **not** orphaned, `dialog.tsx` still uses it and stays.) |
| `menubar.tsx` | `@radix-ui/react-menubar` | only import site was the deleted file |
| `navigation-menu.tsx` | `@radix-ui/react-navigation-menu` | only import site was the deleted file |
| `context-menu.tsx` | `@radix-ui/react-context-menu` | only import site was the deleted file |
| `hover-card.tsx` | `@radix-ui/react-hover-card` | only import site was the deleted file |
| `aspect-ratio.tsx` | `@radix-ui/react-aspect-ratio` | only import site was the deleted file |
| `toggle-group.tsx` | `@radix-ui/react-toggle-group` | only import site was the deleted file |

For each package, verified with
`rg -l 'from "PKG"|from '\''PKG'\''' src/ services/` that the only hit was the
file just deleted, before deleting it.

`package.json` is off-limits to me this wave (integrator/Wave-1a-owned).
**Integrator action:** remove these 12 lines from `dependencies`/
`devDependencies` and re-run `bun install`:
`input-otp`, `embla-carousel-react`, `react-day-picker`, `vaul`,
`react-resizable-panels`, `cmdk`, `@radix-ui/react-menubar`,
`@radix-ui/react-navigation-menu`, `@radix-ui/react-context-menu`,
`@radix-ui/react-hover-card`, `@radix-ui/react-aspect-ratio`,
`@radix-ui/react-toggle-group`.

**Verification run:** `bunx eslint src/components/ui/` — 0 errors (6
pre-existing `react-refresh/only-export-components` warnings, all in files
this wave didn't touch: `badge.tsx`, `button.tsx`, `form.tsx`, `sidebar.tsx`,
`sonner.tsx`, `toggle.tsx`). Re-swept `rg` for the deleted paths across
`src/`, `services/`, `tests/`, `index.html`, `vite.config.ts`,
`tailwind.config.ts`, `components.json` after the deletion — no hits.

## 2. C10 — oversized ONNX wasm in `public/ort/`

**Provenance:** no provisioning script found (checked `scripts/`, `scripts/
train-wakeword/`, and every entry under `package.json`'s `scripts` block,
read-only). `git log --follow` on the wasm file shows exactly one commit,
`a9803bf` ("WS-B B2: on-device wake word — openWakeWord via ONNX/WASM") — the
25.6 MB binary was checked directly into git, not fetched at build/install
time. There is nothing to "update" for this swap; the fix *is* the checked-in
file being replaced. (If a provisioning step is wanted going forward to stop
this drifting again, that's a follow-up, not something I invented this wave —
out of scope as stated.)

**Why single-threaded, non-JSEP is correct here:** `wakeWordRuntime.ts:31-32`
(Wave-1a file, read-only) sets `ort.env.wasm.numThreads = 1` and
`ort.env.wasm.wasmPaths = "/ort/"`; `wakeWordRuntime.ts:68` creates every
session with `executionProviders: ["wasm"]` only — never `"webgpu"` or
`"webnn"`, which is what JSEP exists for. The JSEP build was pure dead weight
for this call site.

**What's actually available to swap to:** `onnxruntime-web@1.27.0` (the
installed version, per `package.json` / `node_modules/onnxruntime-web/
package.json`) no longer ships the old 4-way split (`ort-wasm.wasm` /
`-simd.wasm` / `-threaded.wasm` / `-simd-threaded.wasm`) that older ORT
releases had — `node_modules/onnxruntime-web/dist/` only contains four `.wasm`
files today, all under the `-simd-threaded` name, differentiated by execution
feature, not thread count:

| file | bytes | purpose |
|---|---|---|
| `ort-wasm-simd-threaded.wasm` | 13,479,978 | plain `"wasm"` EP — what wake-word needs |
| `ort-wasm-simd-threaded.jspi.wasm` | ~14 MB | JS Promise Integration variant |
| `ort-wasm-simd-threaded.asyncify.wasm` | ~23 MB | Asyncify fallback (used by the voice-gateway sidecar as its non-threaded-environment fallback, see below) |
| `ort-wasm-simd-threaded.jsep.wasm` | 26,827,543 | JSEP (WebGPU/WebNN) — what was checked in |

The "threaded" in the filename is a build-time pthread-capability flag, not a
runtime requirement — `numThreads = 1` still loads and runs this binary fine
(single-threaded is a runtime env setting, not a separate build in this ORT
release). No smaller variant exists for the plain `"wasm"` EP than this one.

**Change made:** copied `ort-wasm-simd-threaded.wasm` (13,479,978 bytes) and
its paired loader `ort-wasm-simd-threaded.mjs` (24,180 bytes) from
`node_modules/onnxruntime-web/dist/` into `public/ort/`, replacing the two
JSEP files (`ort-wasm-simd-threaded.jsep.wasm`,
`ort-wasm-simd-threaded.jsep.mjs`), which were deleted. Copied from
`node_modules` only — nothing fetched from the network.

| | before | after |
|---|---|---|
| `public/ort/` total | 26,874,157 bytes (25.63 MB) | 13,504,158 bytes (12.88 MB) |
| **delta** | | **-13,369,999 bytes (-12.75 MB, -49.7%)** |

**wasmPaths is a directory, no filename change needed:**
`wakeWordRuntime.ts:32` sets `wasmPaths = "/ort/"` (a directory, not a
filename) and I did not touch that file. ONNX Runtime Web resolves the actual
filename at runtime from feature detection (SIMD support, threading, and
whether a JSEP/WebGPU execution provider was requested) against whatever's in
that directory — it does not read a `.jsep` suffix from config, it decides
whether to *ask for* the jsep-suffixed name based on the execution providers
passed to `InferenceSession.create`. Since `wakeWordRuntime.ts` only ever
passes `executionProviders: ["wasm"]`, no jsep asset was ever requested; the
directory swap alone is sufficient and **no code change is needed in the file
I can't touch.** This is a report entry rather than an integrator action for
exactly that reason — verify by loading the wake-word detector in the app
(`bun run dev`, trigger mic activation) and confirming the network tab
requests `ort-wasm-simd-threaded.wasm`, not a `.jsep.wasm`, and that
`WakeWordDetectorImpl.create` still resolves.

**`services/voice-gateway/src/embeddedAssets.ts` (read-only, off-limits this
wave) — checked, no action needed.** It embeds `ort-wasm-simd-threaded.wasm`
and `.asyncify.wasm` (plus their `.mjs` loaders) directly from
`node_modules/onnxruntime-web/dist` via Bun's `with { type: "file" }` import,
same non-JSEP variant this wave switches `public/ort/` to. The gateway's
comment (`embeddedAssets.ts:22-23`) explains the two-variant embed: the
`.asyncify` fallback exists for the case where the primary loader's
"asyncifies and fetches" path is taken. It does **not** embed the JSEP build.
No oversized-wasm problem on the gateway side — the webview's `public/ort/`
was the only place carrying the JSEP variant.

## 3. Other multi-MB items under `public/` — report only

Below the wasm swap, nothing else in `public/` is worth flagging:

```
1.3M  public/models/embedding_model.onnx
1.2M  public/models/hey_jarvis_v0.1.onnx
1.0M  public/models/melspectrogram.onnx
```

All three are the wake-word pipeline's mandatory/best-effort ONNX models
(`wakeWordRuntime.ts` fetches them from `/models/melspectrogram.onnx` etc.),
already lazy-loaded only on mic activation via the Wave-1a dynamic-import
split — not a bundle-weight problem, not touched this wave. Everything else
under `public/` (`fonts/` 216K, `favicon.svg`/`.ico`, `worklets/`,
`wake-test.html`, `robots.txt`, `placeholder.svg`) is well under the
threshold and not worth a line item.

## What remains in `src/components/ui/`

40 files (was 52). Everything remaining was proof-checked as having at least
one importer during this pass (`toaster.tsx`, `sonner.tsx`, `tooltip.tsx`
explicitly re-verified; the rest were never flagged by the audit finder as
zero-importer candidates, so this wave took no position on them beyond the
three explicit re-checks above).

## Summary

| | count/size |
|---|---|
| Wrapper components deleted | 12 |
| npm packages orphaned (integrator to remove from `package.json`) | 12 |
| `public/ort/` before → after | 25.63 MB → 12.88 MB (**-12.75 MB**) |
| `src/components/ui/` file count before → after | 52 → 40 |

Not included in these numbers: the Wave 1a main-chunk win (1113 → 707 kB) from
un-bundling ONNX out of the eager import graph — that's a separate change, in
a separate commit, and belongs to that wave's report, not this one.
