# ADR 002 — Wake word: openWakeWord on-device (ONNX/WASM)

**Status:** accepted · **Date:** 2026-07-19 · **Branch:** ws-b-duplex

## Context

The legacy wake word used `webkitSpeechRecognition` — Chrome-only, shipped
every word to Google, and does not exist in WKWebView, so it was silently dead
in the shipped Mac app. The duplex rebuild (WS-B) needs an on-device detector
that runs in the app's webview and, later, on ESP32-class hardware.

## Decision

**openWakeWord** (**code** Apache-2.0; **pre-trained models CC BY-NC-SA 4.0** —
see the licence correction below), running client-side via onnxruntime-web WASM:
`melspectrogram.onnx → embedding_model.onnx → wake classifier` over 80 ms
hops, ~3.7 MB of models served from `/models`, ORT runtime from `/ort/`
(`src/lib/wakeWord.ts`). Verified in Safari/WebKit before integration
(`/wake-test.html` probe: full pipeline PASS, ~900 ms cold load, near-zero
score on noise).

**Porcupine rejected:** better accuracy, but custom keywords are a paid tier
and the runtime is closed.

**Placeholder phrase:** the stock `hey_jarvis_v0.1` model until a custom
"Hey Atlas" model is trained (openWakeWord supports custom-phrase training on
synthetic TTS data — follow-up task). The UI already says "Hey Atlas"; until
the custom model lands the actual trigger is "Hey Jarvis".

## Privacy/latency design

The capture worklet feeds every frame to exactly one consumer:
- **idle** → the local detector only. Pre-wake audio never leaves the
  process (not even to the localhost gateway).
- **in a turn** (listening/thinking/speaking) → the gateway only (STT +
  server-side VAD barge-in).

Detection: score ≥ 0.5, 1.5 s refractory. The detector arms after the first
manual mic activation (no permission prompt at app open); from then on the
loop is hands-free.

## Consequences

- Web Speech API is fully gone from the codebase.
- Wake detection costs a few ms of WASM inference per 80 ms hop on the main
  thread; if profiling shows jank it moves to a Web Worker (same module).
- Threshold + custom-model training are open tuning items; false-accept /
  false-reject rates should be measured alongside the Danish bench.

## Licence correction (2026-08-02) — blocks commercial release

This decision recorded openWakeWord as "Apache-2.0". That is true of the
**code** and false of the **models**, and the distinction is the whole issue.
openWakeWord's README:

> All of the code in this repository is licensed under the **Apache 2.0**
> license. All of the included **pre-trained models** are licensed under the
> Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
> license due to the inclusion of datasets with unknown or restrictive
> licensing as part of the training data.

All three files shipped in `public/models/` — `melspectrogram.onnx`,
`embedding_model.onnx`, `hey_jarvis_v0.1.onnx` — are therefore **NonCommercial
and ShareAlike**, and cannot ship in a paid product. The `davidscripka/
openwakeword_features` negative-feature set used by `scripts/train-wakeword/`
carries the same licence, so training a custom "Hey Atlas" model with the kit
as written inherits the problem rather than escaping it.

Exposure is currently limited: these are local development builds and nothing
has been publicly distributed. It must be resolved before any public release
or App Store submission.

**Resolution (does not change the architecture):** Google's `speech_embedding`
module on Kaggle Models is **Apache 2.0** per its model card
(google/speech-embedding, TensorFlow1, v1). openWakeWord's backbone is a
re-implementation of it, and the Google module computes its own log-mel
features internally — so one Apache-2.0 module replaces both
`melspectrogram.onnx` and `embedding_model.onnx` with no retraining. Its
published spec matches `src/lib/wakeWord.ts` exactly (32 mel bins, 25 ms /
10 ms STFT, first embedding at 12400 samples = 76 frames, then every 1280
samples = 8 frames, 96-dim output).

The phrase model is then trained on permissively-licensed negatives, preferring
**CC0** (Mozilla Common Voice) so the unsettled "are weights a derivative work"
question never has to be answered. Porcupine remains the buy-not-build fallback
if this proves too costly.

Ranked alternatives considered: ask dscripka for permissively-licensed weights
(his README invites the request, but depends on his timeline); re-derive from
Google (chosen); switch engines; accept the risk on legal advice (rejected —
inconsistent with the posture already taken against the CC BY-NC community
"hey atlas" model).
