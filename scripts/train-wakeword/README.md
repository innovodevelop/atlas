# Train the "Hey Atlas" wake-word model

`hey_atlas.py` produces `public/models/hey_atlas.onnx`, the phrase model the
app listens with (`src/lib/wakeWord.ts`). It replaced openWakeWord's stock
`hey_jarvis_v0.1.onnx`, which is CC BY-NC-SA and could never ship.

The model reads exactly what the app's detector feeds it: the last 16
embeddings from `public/models/speech_embedding.onnx` (one per 80 ms), as
float32 `[1, 16, 96]`, and returns one probability `[1, 1]`. Training computes
its features with that same backbone, so training and runtime see the same
numbers.

## Licensing: every input, and why it may ship

| Input | Used for | Licence |
|---|---|---|
| [Piper](https://github.com/OHF-Voice/piper1-gpl) `piper-tts` 1.8 | speaking the synthetic clips | GPL-3.0 (the tool; its licence does not reach the audio it generates) |
| Piper voice `en_US-libritts_r-medium` | 904 US speakers saying "hey atlas", near-misses, other speech | voice trained on LibriTTS-R, **CC BY 4.0** |
| Piper voice `en_GB-vctk-medium` | 109 British speakers, same | voice trained on VCTK, **CC BY 4.0** |
| Piper voice `da_DK-talesyntese-medium` | a Danish accent, plus Danish speech as negatives | voice trained on talesyntese, **CC0** |
| [LibriSpeech](https://www.openslr.org/12) | 100 h of real speech as negatives, background speech, and the held-out test | **CC BY 4.0** |
| `speech_embedding.onnx` | features | **Apache-2.0** (Google) |
| noise, reverb, mic EQ | augmentation | generated in code, no dataset |

Two things to know, stated rather than buried:

- All three Piper voices were fine-tuned from Piper's `lessac` voice, whose
  dataset (Blizzard 2013) has a research licence. What goes into training is
  speech those voices generate, not lessac recordings; this is the same
  unsettled "are weights derivative of their training data" question as
  anywhere else, one step removed.
- CC BY 4.0 asks for attribution. LibriSpeech (Panayotov et al., 2015),
  LibriTTS-R (Koizumi et al., 2023) and VCTK (Yamagishi et al., 2019) belong
  in the app's third-party notices.

Never use openWakeWord's pre-computed features
(`davidscripka/openwakeword_features`, CC BY-NC-SA), its `melspectrogram` /
`embedding_model` ONNX files (CC BY-NC-SA), or the community "hey atlas"
model (CC BY-NC). The old `train.sh` used the first two; it is gone.

## Setup (macOS, about 11 GB of disk)

Python 3.12 via [uv](https://docs.astral.sh/uv/); everything lands in the
gitignored `work/clean/`.

```bash
cd scripts/train-wakeword
mkdir -p work/clean && cd work/clean
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r ../../requirements.txt

# Piper voices (about 220 MB), each with its model card.
mkdir -p voices
B=https://huggingface.co/rhasspy/piper-voices/resolve/main
for v in en/en_US/libritts_r/medium/en_US-libritts_r-medium \
         en/en_GB/vctk/medium/en_GB-vctk-medium \
         da/da_DK/talesyntese/medium/da_DK-talesyntese-medium; do
  curl -sSfL -o "voices/$(basename $v).onnx" "$B/$v.onnx"
  curl -sSfL -o "voices/$(basename $v).onnx.json" "$B/$v.onnx.json"
done

# LibriSpeech (7.6 GB unpacked): train-clean-100 to train, dev/test to evaluate.
mkdir -p dl && cd dl
for s in dev-clean test-clean dev-other test-other train-clean-100; do
  curl -sSfL "https://www.openslr.org/resources/12/$s.tar.gz" | tar xz
done
```

## Run

```bash
cd scripts/train-wakeword
work/clean/.venv/bin/python hey_atlas.py all
```

`all` runs the five steps in order; each can also run alone and skips work
whose output already exists (`--force` redoes it):

| Step | Does | Time on an M5 |
|---|---|---|
| `synth` | ~31,000 TTS clips: "hey atlas" (8,000); a fixed near-miss list such as "hey alexa", "at last" (4,000); "hey <word>" over thousands of real words (7,000); "atlas" without "hey", e.g. "ask atlas", "the atlas" (4,000); other English and Danish speech (4,000); plus held-out sets | ~6 min |
| `embed` | puts each clip in a simulated room (level, reverb, mic EQ, background speech or noise, noise floor), then backbone embeddings for everything, LibriSpeech included | ~25 min |
| `train` | a small MLP (1536 → 256 → 256 → 1); negatives weigh more as training goes on, and every 2,000 steps every negative window is rescored and the ones the model likes most go back in as hard negatives | ~4 min |
| `eval` | streams held-out audio through the model the way the app does (80 ms hops, `consecutive` scores in a row, 1.5 s refractory) | ~3 min |
| `export` | `model.pt` → `public/models/hey_atlas.onnx`, checked against torch with onnxruntime | seconds |

Speakers with `id % 10 == 0` are held out of training, so evaluation hears
voices the model never trained on.

## Results

Held out of training: 800 "hey atlas" clips from unseen speakers, 21.4 h of
LibriSpeech dev/test speech, 400 near-misses, 400 "atlas without hey" phrases
and 800 other TTS sentences, all in the same simulated rooms (5–30 dB SNR,
reverb, levels down to someone across the room). `k` is the app's
`consecutive`: scores in a row, 80 ms apart, at or above the threshold.

**Shipped: `hey_atlas.onnx` at k = 2, threshold 0.5** (`src/lib/wakeWord.ts`).

| model | k | thr | recall | false wakes / h | near-misses | "…atlas…" | other TTS speech |
|---|---|---|---|---|---|---|---|
| **hey_atlas** | 2 | 0.5 | **91.0%** | **0.047** (1 in 21.4 h) | 4/400 | 9/400 | 0/800 |
| hey_atlas | 1 | 0.5 | 93.1% | 0.281 | 13/400 | 13/400 | 0/800 |
| hey_atlas | 3 | 0.5 | 88.0% | 0 | 1/400 | 5/400 | 0/800 |
| stock hey_jarvis, as it shipped | 1 | 0.5 | 94.8% | 0.047 | — | — | 0/800 |
| stock hey_jarvis | 2 | 0.5 | 92.2% | 0 | — | — | 0/800 |

(Jarvis was scored on 400 synthetic "hey jarvis" clips; the near-miss and
"atlas" columns are Atlas phrases, so they say nothing about it.)

The same exported file, run through the app's own runtime in a production
build (onnxruntime-web WASM, `wakeWordFraming.ts`, the consecutive rule):
loads in ~280 ms, ~2.4 ms per 80 ms hop, wakes once on each of 8 held-out
clips, stays silent through 4 minutes of held-out speech.

How it got there, so nobody repeats the dead ends:

| change | recall | false wakes / h | what it fixed |
|---|---|---|---|
| first model, mining 100k sampled windows per round | 95.3% | 1.78 | — it woke on "thanks laughed", "tobacco", "she added" with full confidence |
| mine **all** negative windows each round | 94.8% | 0.75 | the confident false wakes; it now overfit the mined windows (0 on training speech, 16 held out) |
| + "hey <word>" near-misses, + `consecutive` | 92.5% (k = 2) | 0 | "hey adam", "hey at": it had learned "hey + a vowel" |
| + "atlas" without "hey" | 91.0% (k = 2) | 0.047 | "the atlas" woke it; "…atlas…" accepts 6.5% → 2.25% |

Hidden width 256 beat 128 at every operating point (at equal false wakes,
~1 point more recall and fewer near-miss accepts).

Known weak spots, measured: the Danish voice is missed more often than the
English ones (12% vs 7% at an earlier checkpoint), and "atlas" said without
"hey" still wakes it about 2% of the time. Everything above is synthetic
speech in simulated rooms: a real microphone is the test that counts.

## Retuning

The threshold lives in `src/lib/wakeWord.ts` (`HEY_ATLAS_THRESHOLD`). Change it
against the table above, not by feel. Synthetic positives are the weak spot:
the real test is a microphone. If real "Hey Atlas" is missed, the cheapest fix
is a lower threshold; the better one is 20–50 real recordings mixed into
`pos_train`. If it fires on the TV, record that audio and add it to the
negatives.
