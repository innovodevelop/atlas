# ADR 002 — Wake word: openWakeWord on-device (ONNX/WASM)

**Status:** accepted · **Date:** 2026-07-19 · **Branch:** ws-b-duplex

## Context

The legacy wake word used `webkitSpeechRecognition` — Chrome-only, shipped
every word to Google, and does not exist in WKWebView, so it was silently dead
in the shipped Mac app. The duplex rebuild (WS-B) needs an on-device detector
that runs in the app's webview and, later, on ESP32-class hardware.

## Decision

**openWakeWord** (Apache-2.0), running client-side via onnxruntime-web WASM:
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
