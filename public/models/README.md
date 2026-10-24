# /models — on-device wake-word ONNX models

Consumed by `src/lib/wakeWordRuntime.ts` (openWakeWord-style pipeline over
onnxruntime-web). Everything runs client-side; audio never leaves the app.

## What ships, and under which licence

| File | Role | Licence |
|---|---|---|
| `speech_embedding.onnx` | 775 ms of 16 kHz audio → 96-dim embedding, every 80 ms | **Apache-2.0** (Google) — see `LICENSE-speech_embedding.txt` |
| `hey_atlas.onnx` | last 16 embeddings → "Hey Atlas" probability | Atlas's own, trained by `scripts/train-wakeword/hey_atlas.py` on permissively licensed data (attribution below) |

Nothing here is non-commercial any more. `src/lib/wakeWord.test.ts` fails if
an `.onnx` file appears here that is neither the backbone nor a listed phrase
model, so a new one has to be added on purpose, with its licence in this table.

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
- openWakeWord's stock `hey_jarvis_v0.1.onnx` (since removed) on a Piper TTS
  "hey jarvis" clip: **0.999** on this backbone vs 0.997 on openWakeWord's; ≈0
  on noise and on other speech.

It also fixed a framing bug: the app ran openWakeWord's mel model on each
1280-sample chunk alone, which yields 5 mel frames per chunk instead of 8, so
every embedding covered ~1.2 s of audio instead of 775 ms. The new backbone
frames audio itself (`src/lib/wakeWordFraming.ts`).

### The phrase model: resolved (2026-10-24)

`hey_atlas.onnx` replaced openWakeWord's stock `hey_jarvis_v0.1.onnx`
(CC BY-NC-SA 4.0), which stood in for it until then. It is trained on
features from `speech_embedding.onnx` itself, so it sees exactly what the app
computes. Held-out results, the operating point (`threshold 0.5`, 2
consecutive scores) and how to retrain: `scripts/train-wakeword/README.md`.

Never place the community "hey atlas" model here: it is CC BY-NC 4.0
(non-commercial) and must not ship with Atlas.

## Attribution

`hey_atlas.onnx` was trained on:

- **LibriSpeech** — V. Panayotov, G. Chen, D. Povey, S. Khudanpur,
  "LibriSpeech: an ASR corpus based on public domain audio books", ICASSP
  2015. CC BY 4.0. https://www.openslr.org/12
- Speech synthesised with Piper voices trained on **LibriTTS-R** — Y. Koizumi
  et al., "LibriTTS-R: A Restored Multi-Speaker Text-to-Speech Corpus",
  Interspeech 2023. CC BY 4.0. https://www.openslr.org/141
- Speech synthesised with a Piper voice trained on **VCTK** — J. Yamagishi,
  C. Veaux, K. MacDonald, "CSTR VCTK Corpus" (version 0.92), University of
  Edinburgh, 2019. CC BY 4.0. https://datashare.ed.ac.uk/handle/10283/3443
- Speech synthesised with a Piper voice trained on **talesyntese** (Danish),
  CC0.

For training, the audio was resampled, mixed and augmented as described in
`scripts/train-wakeword/README.md`. None of it ships with Atlas; only the
trained model does.
