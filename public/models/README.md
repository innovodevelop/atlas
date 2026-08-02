# /models — on-device wake-word ONNX models

Consumed by `src/lib/wakeWord.ts` (openWakeWord pipeline over
onnxruntime-web). Everything runs client-side; audio never leaves the app.

## ⚠️ LICENCE — none of the models here may ship commercially

The three files below are stock openWakeWord **pre-trained models**, and they
are **CC BY-NC-SA 4.0 (NonCommercial + ShareAlike)** — not Apache-2.0. This
file previously claimed Apache-2.0; that was wrong and it mattered.

openWakeWord's own README is explicit about the split:

> All of the code in this repository is licensed under the **Apache 2.0**
> license. All of the included **pre-trained models** are licensed under the
> Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
> license due to the inclusion of datasets with unknown or restrictive
> licensing as part of the training data.

The **code** is Apache-2.0. The **weights** are not. Atlas is a commercial
product, so all three must be replaced before any public release. ShareAlike
alone would be disqualifying even without the NonCommercial clause.

Shipped today — all **CC BY-NC-SA 4.0**, from
[dscripka/openWakeWord](https://github.com/dscripka/openWakeWord):

- `melspectrogram.onnx` — 16 kHz PCM → mel frames (feature stage 1)
- `embedding_model.onnx` — mel frames → 96-dim speech embeddings (stage 2)
- `hey_jarvis_v0.1.onnx` — stock "Hey Jarvis" phrase model, the current
  **fallback** wake phrase

### The replacement path (verified 2026-08-02)

Google's **`speech_embedding`** module on Kaggle Models is **Apache 2.0** —
stated on the model card (google/speech-embedding, TensorFlow1, v1). It is the
model openWakeWord re-implemented, and it **computes its own log-mel features
internally**, so one Apache-2.0 module replaces *both* `melspectrogram.onnx`
and `embedding_model.onnx`.

Its published spec matches this pipeline exactly (see the constants in
`src/lib/wakeWord.ts`): 32 mel bins, 25 ms window / 10 ms step, first embedding
at 12400 samples (775 ms = 76 feature vectors), each subsequent embedding every
1280 samples (80 ms = 8 feature vectors), 96-dim output. A drop-in conversion,
no retraining.

That leaves only the phrase model to train on permissively-licensed negatives
(prefer **CC0** — Mozilla Common Voice — so no attribution or derivative
question arises at all). See `scripts/train-wakeword/README.md`.

Lands here after training (see `scripts/train-wakeword/README.md`):

- `hey_atlas.onnx` — custom "Hey Atlas" phrase model
- `atlas.onnx` — custom "Atlas" phrase model

The app auto-detects: at startup it probes for every known phrase model,
activates the ones present, and drops the "Hey Jarvis" fallback as soon as
any Atlas model loads. Copying trained models into this folder is the entire
deployment step — no code changes.

Never place the community "hey atlas" model here: it is CC BY-NC 4.0
(non-commercial) and must not ship with Atlas.
