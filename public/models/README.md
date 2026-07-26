# /models — on-device wake-word ONNX models

Consumed by `src/lib/wakeWord.ts` (openWakeWord pipeline over
onnxruntime-web). Everything runs client-side; audio never leaves the app.

Shipped today (all stock openWakeWord, **Apache-2.0**, from
[dscripka/openWakeWord](https://github.com/dscripka/openWakeWord)):

- `melspectrogram.onnx` — 16 kHz PCM → mel frames (feature stage 1)
- `embedding_model.onnx` — mel frames → 96-dim speech embeddings (stage 2)
- `hey_jarvis_v0.1.onnx` — stock "Hey Jarvis" phrase model, the current
  **fallback** wake phrase

Lands here after training (see `scripts/train-wakeword/README.md`):

- `hey_atlas.onnx` — custom "Hey Atlas" phrase model
- `atlas.onnx` — custom "Atlas" phrase model

The app auto-detects: at startup it probes for every known phrase model,
activates the ones present, and drops the "Hey Jarvis" fallback as soon as
any Atlas model loads. Copying trained models into this folder is the entire
deployment step — no code changes.

Never place the community "hey atlas" model here: it is CC BY-NC 4.0
(non-commercial) and must not ship with Atlas.
