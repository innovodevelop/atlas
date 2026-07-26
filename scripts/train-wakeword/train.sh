#!/usr/bin/env bash
#
# Local openWakeWord training for Atlas wake phrases.
# Produces output/hey_atlas.onnx and output/atlas.onnx — copy both to
# public/models/ and the app activates them automatically (see README.md).
#
# ============================================================================
# WARNING: THIS DOWNLOADS MULTIPLE GIGABYTES AND RUNS FOR HOURS ON CPU.
#
#   - Pre-computed negative features (ACAV100M), augmentation audio
#     (AudioSet noise/music subset, FMA), and room impulse responses:
#     roughly 10 GB+ of downloads and disk.
#   - Training has no Apple Silicon GPU path (CUDA or CPU only). On a
#     CPU-only Mac each model takes HOURS end to end.
#   - The free Google Colab path in README.md finishes in ~1 h per model
#     on a T4. Prefer it unless you specifically need offline training.
# ============================================================================
set -euo pipefail

read -r -p "This downloads ~10 GB and trains for hours on CPU. Continue? [y/N] " reply
[[ "${reply}" == "y" || "${reply}" == "Y" ]] || { echo "Aborted."; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${HERE}/work"
OUT="${HERE}/output"
mkdir -p "${WORK}" "${OUT}"
cd "${WORK}"

# --- 1) Python env -----------------------------------------------------------
if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install --upgrade pip
pip install -r "${HERE}/requirements.txt"

# --- 2) openWakeWord repo (training pipeline lives in the repo, not the wheel)
if [[ ! -d openWakeWord ]]; then
  git clone https://github.com/dscripka/openWakeWord.git
fi
pip install -e ./openWakeWord

# --- 3) piper-sample-generator (synthetic positive samples via Piper TTS) ----
if [[ ! -d piper-sample-generator ]]; then
  git clone https://github.com/rhasspy/piper-sample-generator.git
  pip install -r piper-sample-generator/requirements.txt
fi
if [[ ! -f piper-sample-generator/models/en_US-libritts_r-medium.pt ]]; then
  mkdir -p piper-sample-generator/models
  curl -L -o piper-sample-generator/models/en_US-libritts_r-medium.pt \
    "https://github.com/rhasspy/piper-sample-generator/releases/download/v2.0.0/en_US-libritts_r-medium.pt"
fi

# --- 4) Shared training data (THE MULTI-GB PART) -----------------------------
# Pre-computed openWakeWord negative features + validation data.
DATA="${WORK}/data"
mkdir -p "${DATA}"
for f in \
  openwakeword_features_ACAV100M_2000_hrs_16bit.npy \
  validation_set_features.npy; do
  if [[ ! -f "${DATA}/${f}" ]]; then
    echo ">>> Downloading ${f} (this one alone is several GB)…"
    curl -L -o "${DATA}/${f}" \
      "https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/${f}"
  fi
done
# Augmentation audio (background noise/music) + room impulse responses are
# fetched by the pipeline's helper; see the repo's
# notebooks/automatic_model_training.ipynb "Download data" cell if you want
# to pre-stage them. mit_rirs is small; audioset/fma are gigabytes.

# --- 5) Train both models ----------------------------------------------------
train_model() {
  local model_name="$1" phrases_yaml="$2"
  local cfg="${WORK}/${model_name}.yml"
  # Start from the repo's reference config and override the Atlas specifics.
  cp openWakeWord/examples/custom_model.yml "${cfg}"
  python - "$cfg" "$model_name" "$phrases_yaml" <<'PY'
import sys, yaml
cfg_path, model_name, phrases = sys.argv[1], sys.argv[2], sys.argv[3]
with open(cfg_path) as f:
    cfg = yaml.safe_load(f)
cfg["model_name"] = model_name
cfg["target_phrase"] = [p.strip() for p in phrases.split("|")]
cfg["n_samples"] = 5000
cfg["n_samples_val"] = 1000
cfg["steps"] = 10000
cfg["output_dir"] = "./trained/" + model_name
cfg["piper_sample_generator_path"] = "./piper-sample-generator"
cfg["background_paths"] = ["./data"]
cfg["false_positive_validation_data_path"] = "./data/validation_set_features.npy"
cfg["feature_data_files"] = {"ACAV100M_sample": "./data/openwakeword_features_ACAV100M_2000_hrs_16bit.npy"}
with open(cfg_path, "w") as f:
    yaml.safe_dump(cfg, f)
PY
  python openWakeWord/openwakeword/train.py --training_config "${cfg}" --generate_clips
  python openWakeWord/openwakeword/train.py --training_config "${cfg}" --augment_clips
  python openWakeWord/openwakeword/train.py --training_config "${cfg}" --train_model
  cp "trained/${model_name}/${model_name}.onnx" "${OUT}/${model_name}.onnx"
  echo ">>> ${OUT}/${model_name}.onnx ready"
}

# Punctuated variants change Piper's prosody — keep them for robustness.
train_model "hey_atlas" "hey atlas|hey atlas!"
train_model "atlas" "atlas|atlas!"

echo
echo "Done. Copy the models into the app:"
echo "  cp ${OUT}/hey_atlas.onnx ${OUT}/atlas.onnx ../../public/models/"
echo "They activate automatically on the next build — no code changes."
