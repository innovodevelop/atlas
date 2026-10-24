#!/usr/bin/env python3
"""
Train public/models/hey_atlas.onnx on data Atlas is allowed to ship.

The phrase model reads what the app's detector feeds it (src/lib/wakeWordRuntime.ts):
the last 16 embeddings from public/models/speech_embedding.onnx, one per 80 ms,
as float32 [1, 16, 96], and returns one probability [1, 1].

Every input is permissively licensed (see README.md for the full table):

  positives   Piper TTS (MIT) saying "hey atlas", 3 voices: LibriTTS-R (CC BY 4.0,
              904 speakers), VCTK (CC BY 4.0, 109 British speakers), Danish
              talesyntese (CC0)
  negatives   LibriSpeech (CC BY 4.0) speech, the same TTS voices saying other
              things and near-misses ("hey alexa", "at last"), synthetic noise
  augment     synthetic only: generated noise, reverb and EQ, LibriSpeech speech
              as background. No third-party noise or impulse-response corpora.
  features    speech_embedding.onnx itself (Google, Apache-2.0): the exact
              backbone the app runs, so training and runtime see the same numbers

Steps (each reads the previous one's output from WORK, default work/clean):

  synth     TTS clips                      -> clips_<set>.npz
  embed     embeddings for clips + corpora -> emb_<set>.npz
  train     the phrase model               -> model.pt
  eval      streaming false-accepts/hour and recall, like the app runs it
  export    model.pt -> hey_atlas.onnx (checked against torch with onnxruntime)

Run from the venv in work/clean (see README.md): python hey_atlas.py all
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
WORK = Path(os.environ.get("WAKE_WORK", HERE / "work" / "clean"))
BACKBONE = REPO / "public" / "models" / "speech_embedding.onnx"
LIBRI = WORK / "dl" / "LibriSpeech"

SR = 16000
WINDOW = 12400  # samples per embedding (775 ms), wakeWordFraming.ts
HOP = 1280  # one embedding per 80 ms
N_EMB = 16  # embeddings per phrase-model input, wakeWordRuntime.ts
# Phrase-model width. 256 over 128: at equal false accepts, ~1 point more
# recall and half the near-miss accepts (README.md, Results).
HIDDEN = int(os.environ.get("WAKE_HIDDEN", 256))
CONTEXT = WINDOW + (N_EMB - 1) * HOP  # 31600 samples (~2 s) behind one score
REFRACTORY = int(1.5 * SR / HOP)  # wakeWordRuntime.ts REFRACTORY_MS, in hops
WORKERS = max(1, (os.cpu_count() or 4) - 2)

# --- Text -------------------------------------------------------------------

POSITIVE = ["hey atlas", "hey atlas!", "hey, atlas", "hey atlas.", "hey atlas?", "Hey Atlas!"]
POSITIVE_DA = ["hey atlas", "hej atlas", "hey atlas!"]

# Near-misses. Plain "atlas" is here on purpose: the phrase is "Hey Atlas".
ADVERSARIAL = [
    "atlas", "the atlas", "an atlas", "atlas shrugged", "at last", "hey at last", "hey, at least",
    "hey atlantis", "hey atlantic", "hey atlanta", "hey alice", "hey alexa", "hey adam", "hey anna",
    "hey dallas", "hey alas", "hey alan", "hey ellis", "hey atticus", "hey attic", "hey a lot",
    "hey jarvis", "hey siri", "hey google", "hey", "hey there", "hey all", "hey at", "hey thanks",
    "hay bales", "a tassel", "hey artist", "hey actress", "hey address", "hey abbas", "hey alex",
    "hey outlast", "a callous",
]
ADVERSARIAL_DA = [
    "hej alle sammen", "hej med dig", "hej anders", "at lave", "atlas", "hej allan", "hej alice",
    "hej atle", "hej mads", "det er lige meget", "hej far", "hej mor", "at læse",
]
SENTENCES_DA = [
    "hvad skal vi have til aftensmad i dag", "kan du tænde lyset i stuen", "jeg kommer hjem lidt senere",
    "har du set mine nøgler", "det regner igen i morgen", "vi skal huske at købe mælk",
    "hvornår går toget til københavn", "sæt musikken lidt højere", "jeg har et møde klokken ni",
    "børnene skal hentes klokken fire", "skal vi gå en tur i parken", "hvad sagde lægen i går",
    "der er fodbold i fjernsynet i aften", "jeg tror ikke det bliver til noget", "kan du sende mig adressen",
    "vi ses i weekenden hos mormor", "kaffen er færdig nu", "har du husket at låse døren",
    "jeg skal lige ringe til banken", "hvad er klokken egentlig", "luk vinduet det er koldt",
    "det var en rigtig god film", "vi mangler brød og ost", "jeg er træt i dag",
    "kan du hjælpe mig med opvasken", "hunden skal ud at gå", "hvor lang tid tager det",
    "jeg glæder mig til sommerferien", "har du læst avisen i dag", "vi skal til tandlæge på tirsdag",
]


def near_misses(seed: int, n: int) -> list[str]:
    """ "hey <word>" and "<word> atlas" for thousands of real words. The fixed
    list above taught the model those phrases; it still woke on "hey adam"
    and "hey at", i.e. on "hey" + any word that starts like "atlas". Words
    starting with a vowel are over-sampled for that reason."""
    words = sorted({w for t in libri_transcripts("train-clean-100") for w in t.split() if len(w) > 1 and "atlas" not in w})
    vowel = [w for w in words if w[0] in "aeiou"]
    rng = random.Random(seed)
    out = []
    for _ in range(n):
        w = rng.choice(vowel if rng.random() < 0.6 else words)
        out.append(f"hey {w}" if rng.random() < 0.85 else f"{w} atlas")
    return out


# Words people put in front of the product's name. Only "hey atlas" wakes.
CARRIERS = ["ask", "okay", "ok", "hi", "hello", "thanks", "thank you", "the", "my", "use", "open", "tell",
            "call", "dear", "yo", "and", "with", "from", "about", "like", "is", "that's", "so", "well", "no"]


def atlas_in_speech(seed: int, n: int) -> list[str]:
    """ "atlas" said without "hey" in front: the product's name in ordinary
    talk ("ask atlas", "the atlas app"). The first exported model woke on
    "the atlas"; a product called Atlas hears its own name all day."""
    words = sorted({w for t in libri_transcripts("train-clean-100") for w in t.split() if len(w) > 1 and "atlas" not in w and w != "hey"})
    rng = random.Random(seed)
    out = []
    for _ in range(n):
        r = rng.random()
        if r < 0.4:
            out.append(f"{rng.choice(CARRIERS)} atlas")
        elif r < 0.75:
            out.append(f"{rng.choice(words)} atlas")
        elif r < 0.9:
            out.append(f"atlas {rng.choice(words)}")
        else:
            out.append(f"{rng.choice(words)} {rng.choice(CARRIERS)} atlas {rng.choice(words)}")
    return out


def libri_transcripts(split: str) -> list[str]:
    out = []
    for f in (LIBRI / split).rglob("*.trans.txt"):
        for line in f.read_text().splitlines():
            out.append(line.split(" ", 1)[1].lower())
    return out


# --- Voices -----------------------------------------------------------------

# (voice, speakers, weight). Speakers with id % 10 == 0 are held out for eval.
VOICES = [
    ("en_US-libritts_r-medium", 904, 0.65),
    ("en_GB-vctk-medium", 109, 0.25),
    ("da_DK-talesyntese-medium", 1, 0.10),
]


def pick_voice(rng: random.Random, held_out: bool, danish_ok: bool = True) -> tuple[str, int | None]:
    while True:
        name, n, _ = rng.choices(VOICES, weights=[w for *_, w in VOICES])[0]
        if name.startswith("da_") and not danish_ok:
            continue
        if n == 1:
            return name, None  # one speaker: used on both sides, told apart by augmentation seed
        while True:
            spk = rng.randrange(n)
            if (spk % 10 == 0) == held_out:
                return name, spk


_loaded: dict = {}


def _tts(job: dict) -> np.ndarray:
    from piper import PiperVoice, SynthesisConfig
    from scipy.signal import resample_poly

    v = _loaded.get(job["voice"])
    if v is None:
        v = _loaded[job["voice"]] = PiperVoice.load(
            str(WORK / "voices" / f"{job['voice']}.onnx"), espeak_data_dir=espeak_data()
        )
        # One thread per worker: Piper's default session takes every core, and
        # eight workers doing that ran slower than one.
        v.session = single_threaded(v.session)
    cfg = SynthesisConfig(
        speaker_id=job["speaker"],
        length_scale=job["length"],
        noise_scale=job["noise"],
        noise_w_scale=job["noise_w"],
    )
    audio = np.concatenate([c.audio_float_array for c in v.synthesize(job["text"], syn_config=cfg)])
    audio = resample_poly(audio, 320, 441).astype(np.float32)  # 22050 -> 16000
    return trim(audio)


def single_threaded(session):
    import onnxruntime as ort

    o = ort.SessionOptions()
    o.intra_op_num_threads = 1
    o.inter_op_num_threads = 1
    return ort.InferenceSession(session._model_path, o, providers=["CPUExecutionProvider"])


def espeak_data() -> str:
    """espeak-ng can't open its data under a path with a space in it (this
    repo's), so point it at a link from the temp dir instead."""
    import tempfile

    from piper.phonemize_espeak import ESPEAK_DATA_DIR

    if " " not in str(ESPEAK_DATA_DIR):
        return str(ESPEAK_DATA_DIR)
    link = Path(tempfile.gettempdir()) / "atlas-wakeword-espeak-ng-data"
    if not link.exists():
        try:
            link.symlink_to(ESPEAK_DATA_DIR)
        except FileExistsError:
            pass  # another worker made it
    return str(link)


def trim(x: np.ndarray, db: float = -40) -> np.ndarray:
    """Cut leading/trailing silence, so a clip ends where the phrase ends."""
    frame = 160
    n = len(x) // frame
    if n == 0:
        return x
    e = np.sqrt((x[: n * frame].reshape(n, frame) ** 2).mean(1) + 1e-12)
    keep = np.where(20 * np.log10(e / (e.max() + 1e-12)) > db)[0]
    if len(keep) == 0:
        return x
    return x[max(0, keep[0] * frame - 800) : min(len(x), (keep[-1] + 1) * frame + 320)]


def synth_jobs(texts_en: list[str], texts_da: list[str], n: int, held_out: bool, seed: int) -> list[dict]:
    rng = random.Random(seed)
    jobs = []
    for _ in range(n):
        voice, spk = pick_voice(rng, held_out, danish_ok=bool(texts_da))
        text = rng.choice(texts_da if voice.startswith("da_") else texts_en)
        jobs.append(
            dict(
                voice=voice, speaker=spk, text=text,
                length=rng.uniform(0.75, 1.35), noise=rng.uniform(0.4, 0.9), noise_w=rng.uniform(0.5, 1.1),
            )
        )
    return jobs


def save_clips(path: Path, clips: list[np.ndarray], texts: list[str]) -> None:
    offsets = np.cumsum([0] + [len(c) for c in clips])
    audio = np.concatenate(clips) if clips else np.zeros(0, np.float32)
    np.savez(path, audio=(np.clip(audio, -1, 1) * 32767).astype(np.int16), offsets=offsets, texts=np.array(texts))


def load_clips(path: Path) -> tuple[list[np.ndarray], list[str]]:
    z = np.load(path)
    a, o = z["audio"].astype(np.float32) / 32768, z["offsets"]
    return [a[o[i] : o[i + 1]] for i in range(len(o) - 1)], list(z["texts"])


def cmd_synth(args) -> None:
    sentences = libri_transcripts("train-clean-100")
    rng = random.Random(7)

    def spans(n: int) -> list[str]:
        out = []
        for _ in range(n):
            words = rng.choice(sentences).split()
            k = rng.randint(3, 10)
            i = rng.randrange(max(1, len(words) - k + 1))
            out.append(" ".join(words[i : i + k]))
        return out

    sets = {
        "pos_train": synth_jobs(POSITIVE, POSITIVE_DA, args.n_pos, held_out=False, seed=1),
        "pos_val": synth_jobs(POSITIVE, POSITIVE_DA, args.n_pos // 10, held_out=True, seed=2),
        "adv_train": synth_jobs(ADVERSARIAL, ADVERSARIAL_DA, args.n_pos // 2, held_out=False, seed=3),
        "adv_val": synth_jobs(ADVERSARIAL, ADVERSARIAL_DA, args.n_pos // 20, held_out=True, seed=4),
        "tts_train": synth_jobs(spans(args.n_pos // 2), SENTENCES_DA, args.n_pos // 2, held_out=False, seed=5),
        "tts_val": synth_jobs(spans(args.n_pos // 10), SENTENCES_DA, args.n_pos // 10, held_out=True, seed=6),
        "near_train": synth_jobs(near_misses(9, 20000), ADVERSARIAL_DA, args.n_pos * 7 // 8, held_out=False, seed=10),
        "name_train": synth_jobs(atlas_in_speech(11, 20000), ["atlas", "spørg atlas", "tak atlas", "det er atlas"], args.n_pos // 2, held_out=False, seed=12),
        "name_val": synth_jobs(atlas_in_speech(13, 2000), [], args.n_pos // 20, held_out=True, seed=14),
        # The stock model, scored the same way, as a reference point.
        "jarvis_val": synth_jobs(["hey jarvis", "hey jarvis!"], [], args.n_pos // 20, held_out=True, seed=8),
    }
    with ProcessPoolExecutor(WORKERS) as pool:
        for name, jobs in sets.items():
            out = WORK / f"clips_{name}.npz"
            if out.exists() and not args.force:
                print(f"have {out.name}")
                continue
            t = time.time()
            clips = list(pool.map(_tts, jobs, chunksize=16))
            save_clips(out, clips, [j["text"] for j in jobs])
            secs = sum(len(c) for c in clips) / SR
            print(f"{name}: {len(clips)} clips, {secs / 60:.1f} min audio, {time.time() - t:.0f}s")


# --- Augmentation -------------------------------------------------------------


def colored_noise(n: int, rng: np.random.Generator, alpha: float) -> np.ndarray:
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n)
    f[0] = f[1]
    x = np.fft.irfft(spec / f ** (alpha / 2), n)
    return (x / (np.abs(x).max() + 1e-9)).astype(np.float32)


def reverb(x: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    from scipy.signal import fftconvolve

    rt60 = rng.uniform(0.15, 0.9)
    n = int(SR * rt60)
    t = np.arange(n) / SR
    h = rng.standard_normal(n) * np.exp(-6.9 * t / rt60) * rng.uniform(0.1, 0.5)
    h[0] = 1.0
    y = fftconvolve(x, h)[: len(x)]
    return (y * (np.abs(x).max() / (np.abs(y).max() + 1e-9))).astype(np.float32)


def eq(x: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    from scipy.signal import butter, sosfilt

    if rng.random() < 0.5:
        sos = butter(4, rng.uniform(2500, 7000), "low", fs=SR, output="sos")
    else:
        sos = butter(2, rng.uniform(80, 400), "high", fs=SR, output="sos")
    return sosfilt(sos, x).astype(np.float32)


class Background:
    """Speech to mix under clips: LibriSpeech train-clean-100 (CC BY 4.0)."""

    def __init__(self, seed: int, n_files: int = 150):
        import soundfile as sf

        files = sorted((LIBRI / "train-clean-100").rglob("*.flac"))
        pick = random.Random(seed).sample(files, min(n_files, len(files)))
        self.audio = np.concatenate([sf.read(f, dtype="float32")[0] for f in pick])

    def take(self, n: int, rng: np.random.Generator) -> np.ndarray:
        i = rng.integers(0, len(self.audio) - n)
        return self.audio[i : i + n]


def level(rng: np.random.Generator) -> float:
    """Peak level, log-uniform from someone across the room (0.02) to close up (0.9)."""
    return float(10 ** rng.uniform(np.log10(0.02), np.log10(0.9)))


def at_snr(sig_rms: float, noise: np.ndarray, snr_db: float) -> np.ndarray:
    nr = np.sqrt((noise**2).mean()) + 1e-9
    return noise * (sig_rms / nr) / (10 ** (snr_db / 20))


def scene(clip: np.ndarray, rng: np.random.Generator, bg: Background, total: int, end_at: int) -> np.ndarray:
    """Place `clip` so it ends at sample `end_at` of a `total`-sample scene, then
    make the scene sound like a room: level, reverb, mic EQ, background, noise floor."""
    out = np.zeros(total, np.float32)
    start = end_at - len(clip)
    if start < 0:
        clip, start = clip[-start:], 0
    out[start:end_at] = clip
    if rng.random() < 0.5:
        out = reverb(out, rng)
    if rng.random() < 0.3:
        out = eq(out, rng)
    out *= level(rng) / (np.abs(out).max() + 1e-9)
    rms = np.sqrt((out[start:end_at] ** 2).mean()) + 1e-9
    r = rng.random()
    if r < 0.35:
        out += at_snr(rms, bg.take(total, rng), rng.uniform(5, 25))
    elif r < 0.65:
        out += at_snr(rms, colored_noise(total, rng, rng.choice([0.0, 1.0, 2.0])), rng.uniform(5, 30))
    out += colored_noise(total, rng, 0.0) * 10 ** (rng.uniform(-70, -45) / 20)  # mic floor
    return np.clip(out, -1, 1).astype(np.float32)


# --- Embedding ------------------------------------------------------------------

_sess = None


def embed(x: np.ndarray) -> np.ndarray:
    """Embeddings for every window that ends on a hop boundary: [K, 96] float32.
    The backbone's shape is fixed at [1, 12400], so this is one call per hop."""
    global _sess
    if _sess is None:
        import onnxruntime as ort

        o = ort.SessionOptions()
        o.intra_op_num_threads = 1
        o.inter_op_num_threads = 1
        _sess = ort.InferenceSession(str(BACKBONE), o, providers=["CPUExecutionProvider"])
    name = _sess.get_inputs()[0].name
    k = (len(x) - WINDOW) // HOP + 1
    out = np.empty((max(k, 0), 96), np.float32)
    for i in range(k):
        out[i] = _sess.run(None, {name: x[None, i * HOP : i * HOP + WINDOW]})[0].reshape(96)
    return out


def _embed_end_aligned(job) -> np.ndarray:
    """One training example per variant: the 16 embeddings whose last window
    ends 0-250 ms after the clip does (what the detector scores right after
    someone finishes the phrase)."""
    clip, seed, variants = job
    rng = np.random.default_rng(seed)
    bg = _bg()
    out = []
    for _ in range(variants):
        x = scene(clip, rng, bg, CONTEXT, CONTEXT - int(rng.integers(0, 4000)))
        out.append(embed(x))
    return np.stack(out)


def _embed_stream(job) -> np.ndarray:
    """The whole clip in a scene with lead-in and tail: every window of it."""
    clip, seed, lead, tail = job
    rng = np.random.default_rng(seed)
    total = lead + len(clip) + tail
    return embed(scene(clip, rng, _bg(), total, lead + len(clip)))


def _embed_file(job) -> np.ndarray:
    import soundfile as sf

    path, seed, augment = job
    x = sf.read(path, dtype="float32")[0]
    if augment:
        rng = np.random.default_rng(seed)
        if rng.random() < 0.4:
            x = reverb(x, rng)
        if rng.random() < 0.3:
            x = eq(x, rng)
        x = x * (level(rng) / (np.abs(x).max() + 1e-9))
        if rng.random() < 0.3:
            x = x + at_snr(np.sqrt((x**2).mean()), colored_noise(len(x), rng, rng.choice([0.0, 1.0, 2.0])), rng.uniform(5, 30))
        x = np.clip(x, -1, 1).astype(np.float32)
    return embed(x).astype(np.float16)


def _embed_noise(seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = SR * 30
    x = colored_noise(n, rng, rng.choice([0.0, 0.5, 1.0, 1.5, 2.0])) * 10 ** (rng.uniform(-60, -3) / 20)
    if rng.random() < 0.3:  # hum
        x += 10 ** (rng.uniform(-50, -10) / 20) * np.sin(2 * np.pi * rng.choice([50, 60, 100]) * np.arange(n) / SR)
    return embed(np.clip(x, -1, 1).astype(np.float32)).astype(np.float16)


_background = None


def _bg() -> Background:
    global _background
    if _background is None:
        _background = Background(seed=os.getpid())
    return _background


def save_ragged(path: Path, parts: list[np.ndarray]) -> None:
    offsets = np.cumsum([0] + [len(p) for p in parts])
    np.savez(path, emb=np.concatenate(parts).astype(np.float16), offsets=offsets)


def cmd_embed(args) -> None:
    with ProcessPoolExecutor(WORKERS) as pool:

        def run(name: str, fn, jobs, ragged: bool) -> None:
            out = WORK / f"emb_{name}.npz"
            if out.exists() and not args.force:
                print(f"have {out.name}")
                return
            t = time.time()
            res = list(pool.map(fn, jobs, chunksize=4))
            if ragged:
                save_ragged(out, res)
            else:
                np.savez(out, emb=np.concatenate(res).astype(np.float16))
            print(f"{name}: {sum(len(r) for r in res)} rows, {time.time() - t:.0f}s")

        for s in ("pos_train", "adv_train"):
            clips, _ = load_clips(WORK / f"clips_{s}.npz")
            run(s, _embed_end_aligned, [(c, 1000 + i, args.variants) for i, c in enumerate(clips)], ragged=False)
        clips, _ = load_clips(WORK / "clips_near_train.npz")
        run("near_train", _embed_end_aligned, [(c, 4000 + i, 3) for i, c in enumerate(clips)], ragged=False)
        run("nears_train", _embed_stream, [(c, 5000 + i, 24000, 8000) for i, c in enumerate(clips)], ragged=True)
        clips, _ = load_clips(WORK / "clips_name_train.npz")
        run("name_train", _embed_end_aligned, [(c, 6000 + i, 3) for i, c in enumerate(clips)], ragged=False)
        run("names_train", _embed_stream, [(c, 7000 + i, 24000, 8000) for i, c in enumerate(clips)], ragged=True)
        clips, _ = load_clips(WORK / "clips_tts_train.npz")
        run("tts_train", _embed_stream, [(c, 2000 + i, 8000, 4000) for i, c in enumerate(clips)], ragged=True)
        # Adversarial clips also as full streams: near-misses at every alignment.
        clips, _ = load_clips(WORK / "clips_adv_train.npz")
        run("advs_train", _embed_stream, [(c, 3000 + i, 24000, 8000) for i, c in enumerate(clips)], ragged=True)
        run("noise_train", _embed_noise, list(range(args.noise_clips)), ragged=True)
        files = sorted(str(p) for p in (LIBRI / "train-clean-100").rglob("*.flac"))
        run("libri_train", _embed_file, [(f, i, True) for i, f in enumerate(files)], ragged=True)

        # Held-out sets: scored as streams, the way the app runs.
        for s, lead, tail in (("pos_val", 24000, 16000), ("jarvis_val", 24000, 16000), ("adv_val", 24000, 16000), ("name_val", 24000, 16000), ("tts_val", 8000, 4000)):
            clips, _ = load_clips(WORK / f"clips_{s}.npz")
            run(s, _embed_stream, [(c, 9000 + i, lead, tail) for i, c in enumerate(clips)], ragged=True)
        files = sorted(str(p) for sp in ("dev-clean", "dev-other", "test-clean", "test-other") for p in (LIBRI / sp).rglob("*.flac"))
        run("libri_val", _embed_file, [(f, i, False) for i, f in enumerate(files)], ragged=True)


# --- Model -----------------------------------------------------------------------


def build_model(mean=None, std=None):
    import torch
    from torch import nn

    class PhraseModel(nn.Module):
        """[B, 16, 96] embeddings -> [B, 1] probability. Input scaling is baked
        in, so the app feeds raw backbone output, as it does for every model."""

        def __init__(self, hidden: int = HIDDEN):
            super().__init__()
            self.register_buffer("mean", torch.zeros(N_EMB * 96) if mean is None else torch.as_tensor(mean))
            self.register_buffer("std", torch.ones(N_EMB * 96) if std is None else torch.as_tensor(std))
            self.net = nn.Sequential(
                nn.Linear(N_EMB * 96, hidden), nn.LayerNorm(hidden), nn.ReLU(), nn.Dropout(0.2),
                nn.Linear(hidden, hidden), nn.LayerNorm(hidden), nn.ReLU(), nn.Dropout(0.2),
                nn.Linear(hidden, 1),
            )

        def logits(self, x):
            return self.net((x.reshape(x.shape[0], -1) - self.mean) / self.std)

        def forward(self, x):
            return torch.sigmoid(self.logits(x))

    return PhraseModel()


class Ragged:
    """Every 16-embedding window of a set of streams, sampled without copying."""

    def __init__(self, *paths: Path):
        embs, starts, base = [], [], 0
        for path in paths:
            z = np.load(path)
            e, off = z["emb"], z["offsets"]
            starts += [np.arange(off[i], off[i + 1] - N_EMB + 1) + base for i in range(len(off) - 1) if off[i + 1] - off[i] >= N_EMB]
            embs.append(e)
            base += len(e)
        self.emb = embs[0] if len(embs) == 1 else np.concatenate(embs)
        self.starts = np.concatenate(starts) if starts else np.zeros(0, np.int64)

    def __len__(self) -> int:
        return len(self.starts)

    def take(self, idx: np.ndarray) -> np.ndarray:
        s = self.starts[idx]
        return self.emb[s[:, None] + np.arange(N_EMB)[None, :]]

    def sample(self, n: int, rng: np.random.Generator) -> np.ndarray:
        return self.take(rng.integers(0, len(self.starts), n))


def score_windows(model, wins: np.ndarray, batch: int = 8192) -> np.ndarray:
    import torch

    out = []
    with torch.no_grad():
        for i in range(0, len(wins), batch):
            out.append(model(torch.from_numpy(wins[i : i + batch].astype(np.float32))).numpy()[:, 0])
    return np.concatenate(out) if out else np.zeros(0, np.float32)


def cmd_train(args) -> None:
    import torch

    torch.manual_seed(0)
    rng = np.random.default_rng(0)
    pos = np.load(WORK / "emb_pos_train.npz")["emb"]
    adv = np.concatenate([np.load(WORK / f"emb_{s}.npz")["emb"] for s in ("adv_train", "near_train", "name_train")])
    tts, noise, libri = (Ragged(WORK / f"emb_{s}.npz") for s in ("tts_train", "noise_train", "libri_train"))
    advs = Ragged(*(WORK / f"emb_{s}.npz" for s in ("advs_train", "nears_train", "names_train")))
    print(f"pos {len(pos)}  adv {len(adv)}  tts {len(tts)}  adv-stream {len(advs)}  noise {len(noise)}  libri {len(libri)} windows")

    flat = np.concatenate([pos[:20000], libri.sample(20000, rng), tts.sample(10000, rng)]).astype(np.float32).reshape(-1, N_EMB * 96)
    model = build_model(flat.mean(0), flat.std(0) + 1e-3)
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-2)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=2e-3, total_steps=args.steps, pct_start=0.1)
    hard = np.zeros((0, N_EMB, 96), np.float16)
    mix = dict(pos=192, adv=96, advs=96, tts=96, noise=32, libri=256, hard=192)

    def batch():
        parts = [
            pos[rng.integers(0, len(pos), mix["pos"])],
            adv[rng.integers(0, len(adv), mix["adv"])],
            advs.sample(mix["advs"], rng),
            tts.sample(mix["tts"], rng),
            noise.sample(mix["noise"], rng),
            libri.sample(mix["libri"], rng),
        ]
        if len(hard):
            parts.append(hard[rng.integers(0, len(hard), mix["hard"])])
        x = np.concatenate(parts).astype(np.float32)
        y = np.zeros(len(x), np.float32)
        y[: mix["pos"]] = 1
        return torch.from_numpy(x), torch.from_numpy(y)

    t = time.time()
    for step in range(1, args.steps + 1):
        model.train()
        x, y = batch()
        # Negatives weigh more as training goes on: a false wake in someone's
        # living room costs more than a missed one, and the hard pool grows.
        w_neg = 1 + (args.neg_weight - 1) * min(1.0, step / (0.6 * args.steps))
        w = torch.where(y > 0, torch.ones_like(y), torch.full_like(y, w_neg))
        loss = torch.nn.functional.binary_cross_entropy_with_logits(model.logits(x)[:, 0], y, weight=w)
        opt.zero_grad()
        loss.backward()
        opt.step()
        sched.step()
        if step % args.mine_every == 0:
            # Hard negatives: the windows the model currently likes most, from
            # ALL of the negative speech, not a sample of it. This, more than
            # the weight, is what drives the false-accept rate down: a first
            # version that mined 100k sampled windows a round still woke on
            # "thanks laughed" and "tobacco" with full confidence.
            model.eval()
            found, n_over = [], 0
            for src in (libri, tts, advs):
                for i in range(0, len(src), 100000):
                    w = src.take(np.arange(i, min(i + 100000, len(src))))
                    sc = score_windows(model, w)
                    n_over += int((sc > 0.5).sum())
                    keep = np.argsort(-sc)[:2000]
                    keep = keep[sc[keep] > 0.05]
                    found.append((sc[keep], w[keep]))
            sc = np.concatenate([f[0] for f in found])
            top = np.concatenate([f[1] for f in found])[np.argsort(-sc)[:20000]]
            hard = np.concatenate([hard, top])[-100000:]
            print(f"step {step}: loss {loss.item():.4f}  w_neg {w_neg:.1f}  negatives>0.5 {n_over}  hard pool {len(hard)}  {time.time() - t:.0f}s", flush=True)
    torch.save(model.state_dict(), WORK / "model.pt")
    print(f"saved {WORK / 'model.pt'}")


# --- Evaluation ------------------------------------------------------------------


def stream_scores(score_fn, path: Path) -> list[np.ndarray]:
    z = np.load(path)
    emb, off = z["emb"].astype(np.float32), z["offsets"]
    out = []
    for i in range(len(off) - 1):
        e = emb[off[i] : off[i + 1]]
        if len(e) < N_EMB:
            out.append(np.zeros(0, np.float32))
            continue
        wins = np.lib.stride_tricks.sliding_window_view(e, (N_EMB, 96))[:, 0]
        out.append(score_fn(wins))
    return out


def fires(scores: np.ndarray, thr: float, k: int) -> list[int]:
    """Where the app would fire: the k-th consecutive score at or above `thr`
    (wakeWordRuntime.ts, `consecutive`), then its 1.5 s refractory."""
    out, run, last = [], 0, -(10**9)
    for i, v in enumerate(scores):
        run = run + 1 if v >= thr else 0
        if run >= k and i - last > REFRACTORY:
            out.append(i)
            last = i
    return out


def events(scores: np.ndarray, thr: float, k: int = 1) -> int:
    return len(fires(scores, thr, k))


def recall(scores: list[np.ndarray], clips_path: Path, lead: int, thr: float, k: int = 1) -> float:
    """A clip counts as heard if the app would fire while it is being said or
    within 1 s after (window i of the stream ends at WINDOW + (i + 15) * HOP).
    Firing during "hey at-" is a wake the user asked for, not a miss."""
    clips, _ = load_clips(clips_path)
    hit = 0
    for s, c in zip(scores, clips):
        end = lead + len(c)
        # window k of the 16-window input ends at sample WINDOW + (k + 15) * HOP
        for i in fires(s, thr, k):
            fire_at = WINDOW + (i + N_EMB - 1) * HOP
            if lead <= fire_at <= end + SR:
                hit += 1
                break
    return hit / max(1, len(clips))


def onnx_scorer(path: Path):
    import onnxruntime as ort

    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    name = sess.get_inputs()[0].name

    def fn(wins: np.ndarray) -> np.ndarray:
        # Fixed batch of 1, as the app runs it (and as the stock models require).
        return np.array([sess.run(None, {name: w[None].astype(np.float32)})[0].reshape(-1)[0] for w in wins], np.float32)

    return fn


def torch_scorer():
    import torch

    model = build_model()
    model.load_state_dict(torch.load(WORK / "model.pt"))
    model.eval()
    return lambda wins: score_windows(model, wins)


def cmd_eval(args) -> None:
    libri_hours = None
    report = {}
    candidates = [("hey_atlas", torch_scorer() if args.model is None else onnx_scorer(Path(args.model)), "pos_val")]
    # The stock model Atlas shipped before this one (CC BY-NC-SA, so it no longer
    # ships): drop a copy in WORK to score it on the same audio, for reference.
    jarvis = WORK / "hey_jarvis_v0.1.onnx"
    if args.jarvis and jarvis.exists():
        candidates.append(("hey_jarvis (stock)", onnx_scorer(jarvis), "jarvis_val"))
    z = np.load(WORK / "emb_libri_val.npz")
    libri_hours = (len(z["emb"]) * HOP + WINDOW * (len(z["offsets"]) - 1)) / SR / 3600
    thresholds = [0.3, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]
    for name, fn, pos_set in candidates:
        t = time.time()
        speech = stream_scores(fn, WORK / "emb_libri_val.npz")
        pos_s = stream_scores(fn, WORK / f"emb_{pos_set}.npz")
        adv_s = stream_scores(fn, WORK / "emb_adv_val.npz")
        name_s = stream_scores(fn, WORK / "emb_name_val.npz")
        tts_s = stream_scores(fn, WORK / "emb_tts_val.npz")
        rows = []
        for k in (1, 2, 3):
            for thr in thresholds:
                fa = sum(events(s, thr, k) for s in speech)
                rows.append(
                    dict(
                        consecutive=k,
                        threshold=thr,
                        recall=round(recall(pos_s, WORK / f"clips_{pos_set}.npz", 24000, thr, k), 4),
                        false_accepts_per_hour=round(fa / libri_hours, 3),
                        false_accepts=fa,
                        near_miss_accepts=f"{sum(events(s, thr, k) > 0 for s in adv_s)}/{len(adv_s)}",
                        name_accepts=f"{sum(events(s, thr, k) > 0 for s in name_s)}/{len(name_s)}",
                        tts_speech_accepts=f"{sum(events(s, thr, k) > 0 for s in tts_s)}/{len(tts_s)}",
                    )
                )
        report[name] = rows
        print(f"\n{name}  (held-out LibriSpeech {libri_hours:.1f} h, {time.time() - t:.0f}s)")
        print(f"{'k':>2} {'thr':>5} {'recall':>7} {'FA/h':>7} {'FA':>5} {'near-miss':>10} {'atlas':>8} {'tts':>9}")
        for r in rows:
            print(f"{r['consecutive']:>2} {r['threshold']:>5} {r['recall']:>7.3f} {r['false_accepts_per_hour']:>7.3f} {r['false_accepts']:>5} {r['near_miss_accepts']:>10} {r['name_accepts']:>8} {r['tts_speech_accepts']:>9}")
    (WORK / "eval.json").write_text(json.dumps(report, indent=2))


# --- Export -----------------------------------------------------------------------


def cmd_export(args) -> None:
    import onnxruntime as ort
    import torch

    model = build_model()
    model.load_state_dict(torch.load(WORK / "model.pt"))
    model.eval()
    out = Path(args.out)
    x = torch.randn(1, N_EMB, 96)
    torch.onnx.export(
        model, x, str(out), input_names=["embeddings"], output_names=["probability"],
        opset_version=13, dynamo=False,
    )
    sess = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"])
    rng = np.random.default_rng(0)
    worst = 0.0
    for _ in range(50):
        w = rng.standard_normal((1, N_EMB, 96)).astype(np.float32)
        a = sess.run(None, {"embeddings": w})[0]
        b = model(torch.from_numpy(w)).detach().numpy()
        worst = max(worst, float(np.abs(a - b).max()))
    print(f"exported {out} ({out.stat().st_size} bytes), max |onnx - torch| = {worst:.2e}")
    assert worst < 1e-4


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", choices=["synth", "embed", "train", "eval", "export", "all"])
    ap.add_argument("--force", action="store_true", help="redo steps whose output exists")
    ap.add_argument("--n-pos", type=int, default=8000, help="positive TTS clips (other sets scale from it)")
    ap.add_argument("--variants", type=int, default=5, help="augmented scenes per positive clip")
    ap.add_argument("--noise-clips", type=int, default=240, help="30 s synthetic noise clips")
    ap.add_argument("--steps", type=int, default=30000)
    ap.add_argument("--neg-weight", type=float, default=10.0)
    ap.add_argument("--mine-every", type=int, default=2000)
    ap.add_argument("--model", help="eval: score this .onnx instead of model.pt")
    ap.add_argument("--jarvis", action="store_true", help="eval: also score the stock hey_jarvis model")
    ap.add_argument("--out", default=str(REPO / "public" / "models" / "hey_atlas.onnx"))
    args = ap.parse_args()
    WORK.mkdir(parents=True, exist_ok=True)
    steps = ["synth", "embed", "train", "eval", "export"] if args.step == "all" else [args.step]
    for s in steps:
        print(f"=== {s}", flush=True)
        globals()[f"cmd_{s}"](args)


if __name__ == "__main__":
    sys.exit(main())
