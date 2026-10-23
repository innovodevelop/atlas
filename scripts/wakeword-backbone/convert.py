"""Convert Google's speech_embedding (Apache-2.0) to ONNX and check it against
the openWakeWord backbone it would replace (ROADMAP.md, blocker 1 / feat-023).

Runs in CI (.github/workflows/wakeword-backbone.yml): Kaggle / TF Hub are not
reachable from every dev environment, and the TensorFlow toolchain is not
something to install on the Mac. Writes into OUT_DIR:

  speech_embedding.onnx   waveform [1, 12400] float32 in [-1, 1] -> [1, 1, 1, 96]
                          (one 775 ms window -> one embedding; the app slides
                          it by 1280 samples, as it slides the mel window now)
  report.json             what was checked and how close it came
  report.md               the same, for a human

Checks, in order of what they prove:

  1. ONNX vs TensorFlow on the same audio: the conversion is faithful.
  2. Google vs openWakeWord embeddings on the same audio: whether the module
     is the drop-in replacement ROADMAP.md says (openWakeWord re-implemented
     it). Reported as cosine similarity per embedding.
  3. hey_jarvis_v0.1.onnx scored on both backbones for a synthetic
     "hey jarvis" clip (Piper TTS) and for silence/noise: whether a phrase
     model trained on the old backbone still works on the new one.

Nothing here decides anything. The report states the numbers; whether the
backbone is swapped is a decision recorded in ROADMAP.md.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

OUT = Path(os.environ.get("OUT_DIR", "out"))
MODELS = Path(os.environ.get("MODELS_DIR", "public/models"))
OPSET = int(os.environ.get("OPSET", "15"))
SR = 16000
# One embedding's worth of audio. A fixed length is what makes the graph
# convertible: with an open length, tf2onnx can't infer the shapes of the
# module's per-batch map loop or its convolutions.
WINDOW = 12400
HOP = 1280
TFHUB = "https://tfhub.dev/google/speech_embedding/1"
KAGGLE = "google/speech-embedding/tensorFlow1/speech-embedding/1"

report: dict = {"opset": OPSET, "steps": []}


def step(name: str, **data) -> None:
    print(f"[{name}] {json.dumps(data, default=str)[:2000]}", flush=True)
    report["steps"].append({"name": name, **data})


# ---------------------------------------------------------------------------
# 1. Load the TF1 Hub module as a frozen TF1 graph
# ---------------------------------------------------------------------------

def resolve_module() -> str:
    """Local path of the module: TF Hub first (it redirects to Kaggle's
    storage), Kaggle's own client second."""
    import tensorflow_hub as hub

    errors = []
    try:
        path = hub.resolve(TFHUB)
        step("load", source="tfhub", path=path)
        return path
    except Exception as e:  # noqa: BLE001 - every failure is reported
        errors.append(f"tfhub: {type(e).__name__}: {e}")
    try:
        import kagglehub

        path = kagglehub.model_download(KAGGLE)
        step("load", source="kaggle", path=path)
        return path
    except Exception as e:  # noqa: BLE001
        errors.append(f"kaggle: {type(e).__name__}: {e}")
    raise SystemExit("could not load speech_embedding:\n" + "\n".join(errors))


def freeze_with_references(arrays: list[np.ndarray]):
    """The module as a frozen TF1 GraphDef with input `waveform` [1, WINDOW]
    and output `embedding`, plus TensorFlow's own full-length output for each
    of `arrays` (the reference the ONNX model is checked against).

    TF1 graph mode, not the TF2 KerasLayer: through the Keras wrapper the
    module's graph reaches tf2onnx without static shapes, and its per-batch
    map loop and convolutions then can't be converted at all."""
    import tensorflow.compat.v1 as tf1
    import tensorflow_hub as hub

    tf1.disable_eager_execution()
    path = resolve_module()
    graph = tf1.Graph()
    with graph.as_default():
        module = hub.Module(path)
        x = tf1.placeholder(tf1.float32, [1, WINDOW], name="waveform")
        tf1.identity(module(x), name="embedding")
        x_any = tf1.placeholder(tf1.float32, [1, None], name="waveform_any")
        y_any = module(x_any)
        with tf1.Session(graph=graph) as sess:
            sess.run([tf1.global_variables_initializer(), tf1.tables_initializer()])
            refs = [sess.run(y_any, {x_any: a[None]}).reshape(-1, 96) for a in arrays]
            frozen = tf1.graph_util.convert_variables_to_constants(sess, graph.as_graph_def(), ["embedding"])
    frozen = tf1.graph_util.extract_sub_graph(frozen, ["embedding"])
    step("freeze", nodes=len(frozen.node), ops=sorted({n.op for n in frozen.node}))
    return frozen, refs


# ---------------------------------------------------------------------------
# Audio
# ---------------------------------------------------------------------------

def tts_clip(text: str) -> np.ndarray | None:
    """A 16 kHz float clip of `text` from Piper, or None if Piper isn't there."""
    voice = os.environ.get("PIPER_VOICE")
    if not voice or not Path(voice).exists():
        return None
    wav = OUT / f"{text.replace(' ', '_')}.wav"
    try:
        subprocess.run(
            [sys.executable, "-m", "piper", "--model", voice, "--output_file", str(wav)],
            input=text.encode(), check=True, capture_output=True,
        )
    except Exception as e:  # noqa: BLE001
        step("tts-failed", text=text, error=str(e))
        return None
    with wave.open(str(wav)) as w:
        rate = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    if rate != SR:
        # Linear resample is plenty for a feature-equivalence check.
        n = int(len(pcm) * SR / rate)
        pcm = np.interp(np.linspace(0, len(pcm) - 1, n), np.arange(len(pcm)), pcm).astype(np.float32)
    return pcm


def padded(clip: np.ndarray, seconds: float = 3.0) -> np.ndarray:
    """Clip centred in low noise, long enough for 16 embeddings after it."""
    rng = np.random.default_rng(1)
    total = int(seconds * SR)
    out = (rng.standard_normal(total) * 0.002).astype(np.float32)
    start = max(0, (total - len(clip)) // 2)
    out[start:start + len(clip)] += clip[: total - start]
    return out


# ---------------------------------------------------------------------------
# Backbones
# ---------------------------------------------------------------------------

def oww_sessions():
    import onnxruntime as ort

    mel_p, emb_p = MODELS / "melspectrogram.onnx", MODELS / "embedding_model.onnx"
    if not (mel_p.exists() and emb_p.exists()):
        return None
    return ort.InferenceSession(str(mel_p)), ort.InferenceSession(str(emb_p))


def oww_mel(mel, pcm: np.ndarray) -> np.ndarray:
    out = mel.run(None, {mel.get_inputs()[0].name: pcm[None].astype(np.float32)})[0]
    return out[0, 0] / 10 + 2  # openWakeWord's scaling, as in wakeWordRuntime.ts


def oww_embeddings(audio: np.ndarray) -> np.ndarray | None:
    """openWakeWord's two-stage backbone with its intended framing: mel over
    the whole clip (int16-range input, 10 ms frames), then a 76-frame window
    hopping 8 frames, i.e. one embedding per 1280 samples."""
    sessions = oww_sessions()
    if sessions is None:
        return None
    mel, emb = sessions
    frames = oww_mel(mel, audio * 32767.0)
    embs = [
        emb.run(None, {emb.get_inputs()[0].name: frames[s:s + 76][None, :, :, None].astype(np.float32)})[0].reshape(96)
        for s in range(0, len(frames) - 76 + 1, 8)
    ]
    return np.array(embs, dtype=np.float32)


def app_chunk_framing() -> dict | None:
    """How many mel frames src/lib/wakeWordRuntime.ts gets per 1280-sample
    chunk: it runs the mel model on each chunk alone, with no overlap.
    openWakeWord's own streaming prepends 480 samples of context so each
    chunk yields 8 frames (80 ms of 10 ms frames); fewer means the app's
    76-frame windows span more than 760 ms of audio."""
    sessions = oww_sessions()
    if sessions is None:
        return None
    mel, _ = sessions
    zeros = np.zeros(1280, dtype=np.float32)
    with_context = np.zeros(1280 + 480, dtype=np.float32)
    return {
        "frames_per_1280_chunk_alone": int(oww_mel(mel, zeros).shape[0]),
        "frames_per_1280_chunk_with_480_context": int(oww_mel(mel, with_context).shape[0]),
        "expected": 8,
    }


def phrase_scores(model: Path, embs: np.ndarray) -> list[float]:
    import onnxruntime as ort

    s = ort.InferenceSession(str(model))
    name = s.get_inputs()[0].name
    return [
        float(s.run(None, {name: embs[i - 16:i][None].astype(np.float32)})[0].reshape(-1)[0])
        for i in range(16, len(embs) + 1)
    ]


def cosine(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return (a * b).sum(-1) / (np.linalg.norm(a, axis=-1) * np.linalg.norm(b, axis=-1) + 1e-9)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    import onnx
    import onnxruntime as ort
    import tf2onnx

    OUT.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(0)
    tests = [(rng.standard_normal(n) * 0.1).astype(np.float32) for n in (WINDOW, WINDOW + HOP, SR * 2, SR * 3 + 17)]
    frozen, refs = freeze_with_references(tests)
    step("tf-reference", shapes=[r.shape for r in refs])

    onnx_path = OUT / "speech_embedding.onnx"
    model_proto, _ = tf2onnx.convert.from_graph_def(
        frozen, input_names=["waveform:0"], output_names=["embedding:0"], opset=OPSET, output_path=str(onnx_path),
    )
    ops = sorted({n.op_type for n in model_proto.graph.node})
    step("convert", opset=OPSET, ops=ops, bytes=onnx_path.stat().st_size)
    onnx.checker.check_model(str(onnx_path))

    sess = ort.InferenceSession(str(onnx_path))
    in_name = sess.get_inputs()[0].name

    def g(audio: np.ndarray) -> np.ndarray:
        """Embeddings the way the app would stream them: one ONNX call per
        WINDOW-sample window, sliding by HOP."""
        out = [
            sess.run(None, {in_name: audio[None, s:s + WINDOW].astype(np.float32)})[0].reshape(96)
            for s in range(0, len(audio) - WINDOW + 1, HOP)
        ]
        return np.array(out, dtype=np.float32)

    # 1. Faithful conversion, AND streaming fidelity: sliding fixed windows
    #    must reproduce TensorFlow's output for the whole clip at once.
    worst = 0.0
    for a, t in zip(tests, refs):
        n = len(a)
        o = g(a)
        m = min(len(t), len(o))
        diff = float(np.abs(t[:m] - o[:m]).max())
        worst = max(worst, diff)
        step("onnx-vs-tf", samples=n, tf_embeddings=len(t), onnx_embeddings=len(o), max_abs_diff=diff)
    report["onnx_vs_tf_max_abs_diff"] = worst

    framing = app_chunk_framing()
    if framing is not None:
        step("app-chunk-framing", **framing)
        report["app_chunk_framing"] = framing

    # 2. Same audio through both backbones.
    clips = {"noise": (rng.standard_normal(SR * 3) * 0.05).astype(np.float32)}
    jarvis = tts_clip("hey jarvis")
    if jarvis is not None:
        clips["hey_jarvis_tts"] = padded(jarvis)
    other = tts_clip("what is the weather today")
    if other is not None:
        clips["other_speech_tts"] = padded(other)

    for name, audio in clips.items():
        new = g(audio).reshape(-1, 96)
        old = oww_embeddings(audio)
        entry: dict = {"clip": name, "google_embeddings": int(len(new))}
        if old is not None:
            n = min(len(new), len(old))
            # openWakeWord starts its first window at chunk 0 too; align by
            # trying small offsets and keeping the best.
            best = max(
                ((off, float(np.median(cosine(new[max(off, 0):n + min(off, 0)], old[max(-off, 0):n - max(off, 0)])))) for off in range(-3, 4)),
                key=lambda x: x[1],
            )
            entry.update(oww_embeddings=int(len(old)), best_offset=best[0], median_cosine=best[1])
            jarvis_model = MODELS / "hey_jarvis_v0.1.onnx"
            if jarvis_model.exists() and n >= 16:
                entry["hey_jarvis_max_score_oww"] = max(phrase_scores(jarvis_model, old))
                entry["hey_jarvis_max_score_google"] = max(phrase_scores(jarvis_model, new))
        step("backbone-compare", **entry)
        report.setdefault("compare", []).append(entry)

    (OUT / "report.json").write_text(json.dumps(report, indent=2, default=str))
    lines = [
        "# speech_embedding → ONNX",
        "",
        f"- Opset {OPSET}; ops: {', '.join(ops)}",
        f"- ONNX vs TensorFlow, worst absolute difference: {worst:.2e}",
        "",
        *(
            [f"- App's mel framing: {framing['frames_per_1280_chunk_alone']} frames per 1280-sample chunk "
             f"(openWakeWord expects {framing['expected']}; with 480 samples of context: "
             f"{framing['frames_per_1280_chunk_with_480_context']})", ""]
            if framing else []
        ),
        "| clip | Google embeddings | oWW embeddings | median cosine | hey_jarvis (oWW) | hey_jarvis (Google) |",
        "|---|---|---|---|---|---|",
    ]
    for c in report.get("compare", []):
        fmt = lambda v: f"{v:.3f}" if isinstance(v, float) else str(v if v is not None else "—")  # noqa: E731
        lines.append(
            f"| {c['clip']} | {c['google_embeddings']} | {c.get('oww_embeddings', '—')} | {fmt(c.get('median_cosine'))} "
            f"| {fmt(c.get('hey_jarvis_max_score_oww'))} | {fmt(c.get('hey_jarvis_max_score_google'))} |"
        )
    (OUT / "report.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
