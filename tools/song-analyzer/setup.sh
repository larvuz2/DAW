#!/usr/bin/env bash
# Builds tools/song-analyzer/.venv from scratch (Linux x86-64, CPU only). Needs: uv, ffmpeg, a C/C++ compiler
# and cmake (NATTEN is compiled from source, ~1 min), Python 3.11 (uv downloads it if missing), and the repository's
# own `npm install` (loudness, true peak and band balance are measured with the studio's meter: measure.mjs).
# Exact versions of everything that was tested: requirements.lock.txt.
# Ported from the GGS Composer repository (tools/song-analyzer); see docs/song-studies.md for how it is used here.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
command -v uv >/dev/null || pip install uv
command -v ffmpeg >/dev/null || { echo "install ffmpeg first (apt-get install -y ffmpeg)" >&2; exit 1; }
uv venv --python 3.11 .venv
PY=.venv/bin/python
CPU=https://download.pytorch.org/whl/cpu
# 1. CPU-only PyTorch first, then everything else pinned against it (unsafe-best-match lets uv mix both indexes)
uv pip install --python $PY --index-url $CPU "torch==2.5.1+cpu" "torchaudio==2.5.1+cpu" "torchvision==0.20.1+cpu"
# requirements.lock.txt pins every transitive package to the tested version (lines installed separately below excluded)
grep -v -E '^(madmom|natten|allin1|basic-pitch)' requirements.lock.txt > .venv/constraints.txt
uv pip install --python $PY --index-url $CPU --extra-index-url https://pypi.org/simple --index-strategy unsafe-best-match \
  -c .venv/constraints.txt "torch==2.5.1+cpu" "torchaudio==2.5.1+cpu" "torchvision==0.20.1+cpu" \
  demucs==4.0.1 beat-this==1.1.0 librosa==0.11.0 soundfile scipy matplotlib pretty_midi mido mir_eval==0.8.2 \
  fal-client==1.0.3 faster-whisper==1.2.1 panns_inference==0.1.1 "essentia==2.1b6.dev1389" "numpy<2.1" \
  onnxruntime resampy "timm==1.0.11" hydra-core omegaconf playwright==1.58.0 markdown cython setuptools wheel \
  scikit-learn huggingface-hub typing-extensions   # deps of basic-pitch and allin1, which go in with --no-deps
# 2. madmom from GitHub (the PyPI release does not build on current numpy)
uv pip install --python $PY --no-build-isolation "git+https://github.com/CPJKU/madmom@27f032e8947204902c675e5e341a3faf5dc86dae"
# 3. Basic Pitch without TensorFlow (its ONNX model runs on onnxruntime)
uv pip install --python $PY --no-deps "basic-pitch==0.4.0"
# 4. All-In-One structure analyzer + NATTEN 0.17.5 compiled for CPU (the prebuilt wheel site's certificate had
#    expired in Nov 2026; songanalyzer/structure.py maps allin1's old NATTEN calls onto the 0.17 API)
NATTEN_WITH_CUDA=0 NATTEN_N_WORKERS=4 uv pip install --python $PY --no-build-isolation "natten==0.17.5"
uv pip install --python $PY --no-deps allin1==1.1.0
# 5. Model weights are downloaded on first use: Demucs (~80 MB each), Beat This (77 MB), madmom (bundled),
#    allin1 (8 x ~10 MB), PANNs Cnn14 (327 MB, ~/panns_data), faster-whisper small (~480 MB).
mkdir -p ~/panns_data
[ -s ~/panns_data/Cnn14_mAP=0.431.pth ] || curl -L -o ~/panns_data/Cnn14_mAP=0.431.pth \
  "https://zenodo.org/record/3987831/files/Cnn14_mAP%3D0.431.pth?download=1"
# 6. Headless Chromium for report.pdf (skipped when a Playwright browser already exists under /opt/pw-browsers)
ls /opt/pw-browsers/chromium_headless_shell-* >/dev/null 2>&1 || [ -n "${CHROMIUM_PATH:-}" ] || .venv/bin/playwright install chromium
echo "ready: tools/song-analyzer/analyze <audio> --out <dir>"
