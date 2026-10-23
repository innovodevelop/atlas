# /models — on-device wake-word ONNX models

Consumed by `src/lib/wakeWordRuntime.ts` (openWakeWord-style pipeline over
onnxruntime-web). Everything runs client-side; audio never leaves the app.

## What ships, and under which licence

| File | Role | Licence |
|---|---|---|
| `speech_embedding.onnx` | 775 ms of 16 kHz audio → 96-dim embedding, every 80 ms | **Apache-2.0** (Google) — see `LICENSE-speech_embedding.txt` |
| `hey_jarvis_v0.1.onnx` | last 16 embeddings → "Hey Jarvis" probability (fallback phrase) | **CC BY-NC-SA 4.0** — must not ship commercially |

### The backbone: resolved (2026-10-23)

`speech_embedding.onnx` is Google's `speech_embedding` module (TF Hub /
Kaggle Models, **Apache 2.0** per its model card), converted to ONNX by
`scripts/wakeword-backbone/convert.py` in CI
(`.github/workflows/wakeword-backbone.yml`). It replaced openWakeWord's
`melspectrogram.onnx` + `embedding_model.onnx`, which are **CC BY-NC-SA 4.0**
and have been removed.

openWakeWord's backbone is a re-implementation of this module, so phrase models
trained for openWakeWord run on it unchanged. The CI comparison measured that,
rather than assuming it:

- ONNX vs TensorFlow: max difference 4.4e-5; sliding 12400-sample windows by
  1280 reproduces the module's full-length output.
- Embeddings vs openWakeWord's pair on the same audio: median cosine 0.95–0.97.
- `hey_jarvis_v0.1.onnx` on a Piper TTS "hey jarvis" clip: **0.999** on this
  backbone vs 0.997 on openWakeWord's; ≈0 on noise and on other speech.

It also fixed a framing bug: the app ran openWakeWord's mel model on each
1280-sample chunk alone, which yields 5 mel frames per chunk instead of 8, so
every embedding covered ~1.2 s of audio instead of 775 ms. The new backbone
frames audio itself (`src/lib/wakeWordFraming.ts`).

### What still blocks a commercial release

Only the **phrase model**. `hey_jarvis_v0.1.onnx` is CC BY-NC-SA 4.0, and the
UI says "Hey Atlas". Train `hey_atlas.onnx` / `atlas.onnx` on
permissively-licensed negatives (prefer **CC0**, Mozilla Common Voice) with
embeddings computed by `speech_embedding.onnx`; see
`scripts/train-wakeword/README.md`.

Lands here after training:

- `hey_atlas.onnx` — custom "Hey Atlas" phrase model
- `atlas.onnx` — custom "Atlas" phrase model

The app auto-detects: at startup it probes for every known phrase model,
activates the ones present, and drops the "Hey Jarvis" fallback as soon as
any Atlas model loads. Copying trained models into this folder is the entire
deployment step — no code changes.

Never place the community "hey atlas" model here: it is CC BY-NC 4.0
(non-commercial) and must not ship with Atlas.
