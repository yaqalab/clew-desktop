#!/bin/sh
# Packs the local dictation server into a folder that needs no Python, on macOS and Linux: the
# POSIX twin of build_exe.ps1 (same PyInstaller arguments, same reasons).
#
#   sh tools/stt-server/build_dist.sh
#
# Builds with `python3` (or $PYTHON) in a throwaway virtual environment, so PyInstaller is not
# installed into your Python. The program runs on systems like the one it was built on: a Linux
# build needs a glibc at least as new as the build machine's.
# Result: tools/stt-server/dist/clew-stt-server/clew-stt-server
set -eu
cd "$(dirname "$0")"

venv="${TMPDIR:-/tmp}"
venv="${venv%/}/clew-stt-server-build"
py="$venv/bin/python"
if [ ! -x "$py" ]; then
  rm -rf "$venv"
  "${PYTHON:-python3}" -m venv "$venv"
fi
"$py" -m pip install --quiet --disable-pip-version-check pyinstaller -e ".[local]"

# Left out: the Hailo engine's imports (lazy, Pi only), onnxruntime (faster-whisper's own VAD,
# unused: the segmenter finds the speech), and the usual heavy strays.
set --
for m in torch hailo_apps hailo_platform onnxruntime tkinter matplotlib PIL scipy pandas \
         IPython webrtcvad pytest hf_xet sqlite3; do
  set -- "$@" --exclude-module "$m"
done

"$py" -m PyInstaller --noconfirm --clean --onedir --console --name clew-stt-server \
  --distpath dist --workpath "$venv/work" --specpath "$venv/spec" \
  --collect-submodules uvicorn --collect-submodules websockets \
  --collect-binaries ctranslate2 --collect-data faster_whisper --collect-binaries sherpa_onnx \
  "$@" \
  clew_stt_server.py

dir="$(pwd)/dist/clew-stt-server"
# The licences of everything packed in, installed beside the program (third_party_notices.py).
"$py" third_party_notices.py "$dir/THIRD-PARTY-NOTICES.txt"
echo "Built $dir ($(du -sm "$dir" | cut -f1) MB)"
