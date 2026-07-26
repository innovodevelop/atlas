# Train the "Hey Atlas" / "Atlas" wake-word models

Atlas detects its wake phrase fully on-device with
[openWakeWord](https://github.com/dscripka/openWakeWord) (**Apache-2.0**).
The app currently ships openWakeWord's stock `hey_jarvis_v0.1.onnx` as a
fallback phrase. This kit produces the two custom phrase models that replace
it:

| Output           | Phrase      |
| ---------------- | ----------- |
| `hey_atlas.onnx` | "Hey Atlas" |
| `atlas.onnx`     | "Atlas"     |

**Activation is zero-code:** copy the trained `.onnx` files into
`public/models/` and rebuild/reload. `src/lib/wakeWord.ts` probes for them at
startup, activates every model it finds, and automatically drops the
"Hey Jarvis" fallback the moment any Atlas model loads. The dashboard label
("Listening for …") follows automatically.

## Licensing — read before shipping anything

- **Do NOT ship the community "hey atlas" model** (e.g. the atlas-voice /
  home-assistant community collections). It is licensed **CC BY-NC 4.0 —
  non-commercial only** and can never be bundled with Atlas.
- **Models trained with this kit are ours to ship.** openWakeWord's automatic
  training pipeline is Apache-2.0 and generates its own synthetic speech
  (Piper TTS) for training data. A model we train with it is our own work
  product: we may license and distribute it however we like, including
  commercially inside Atlas. Ship it under the Atlas app license and credit
  openWakeWord (Apache-2.0 tooling) in the third-party notices.

## Path A — Google Colab (recommended, free, ~1 hour per model)

openWakeWord's maintained notebook does everything on a free T4 GPU.

1. Open `notebooks/automatic_model_training.ipynb` from the
   [dscripka/openWakeWord](https://github.com/dscripka/openWakeWord) repo in
   Google Colab (the repo README links a one-click Colab badge, often named
   `training_models.ipynb` in older revisions). Runtime → T4 GPU.
2. Run it **twice**, once per model, with these config values:

   **Run 1 — hey_atlas.onnx**
   - `target_phrase`: `["hey atlas", "hey atlas!"]` (the punctuated variant
     changes Piper's prosody and improves robustness)
   - `model_name`: `hey_atlas`
   - `n_samples`: `5000` (positive training clips; more = better, slower)
   - `n_samples_val`: `1000`
   - `steps`: `10000` (default is fine)

   **Run 2 — atlas.onnx**
   - `target_phrase`: `["atlas", "atlas!"]`
   - `model_name`: `atlas`
   - `n_samples`: `5000`, `n_samples_val`: `1000`, `steps`: `10000`

   Single-word phrases trigger more false positives than multi-word ones —
   expect to raise the in-app threshold for `atlas.onnx` if it fires on
   "at last", "atlantic", etc. (per-model `threshold` in
   `src/lib/wakeWord.ts` `WAKE_MODELS`).
3. Each run takes roughly an hour on a T4 (sample generation + augmentation +
   training). Download the resulting ONNX file, name it exactly
   `hey_atlas.onnx` / `atlas.onnx`, and copy it to `public/models/`.

## Path B — local training (`train.sh`)

> **WARNING — big downloads, long runtime. Do not run casually.**
> The pipeline downloads **multiple gigabytes** of pre-computed negative
> features, augmentation audio (noise/music), and room-impulse responses
> (roughly 10 GB+ on disk), and training takes **hours on CPU** (no Apple
> Silicon GPU support in the training stack — it is CUDA-or-CPU). The Colab
> path is faster and free. Use this only if you need offline/reproducible
> training.

```bash
cd scripts/train-wakeword
./train.sh            # trains both models into ./output/
```

The script creates a `python3` venv, installs `requirements.txt` plus
openWakeWord's training extras, clones `piper-sample-generator` for synthetic
speech, downloads the negative/augmentation datasets, then runs openWakeWord's
automatic pipeline (`--generate_clips` → `--augment_clips` → `--train_model`)
once per phrase. Outputs land in `output/hey_atlas.onnx` and
`output/atlas.onnx` — copy them to `public/models/`.

## After training

1. Copy `hey_atlas.onnx` and `atlas.onnx` to `public/models/`.
2. Rebuild (`bun run build`) — no code changes needed; the detector and the
   "Listening for …" label pick them up automatically.
3. Update the atlas-site privacy policy in the same release: it currently
   states the beta wake phrase is "Hey Jarvis", which stops being true once
   these models ship.
4. Test real-world false-positive rates; tune per-model `threshold` in
   `WAKE_MODELS` (`src/lib/wakeWord.ts`) if needed.
