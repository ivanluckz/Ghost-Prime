#!/usr/bin/env bash
# Set up the always-on wake-word daemon in a self-contained venv. Debian/Crostini Python is
# "externally managed" (PEP 668), so we never touch system site-packages.
set -e
cd "$(dirname "$0")"

echo "==> venv + deps (vosk, sounddevice)…"
if [ ! -d .venv ]; then
  python3 -m venv .venv 2>/dev/null || {
    echo "Couldn't create a Python venv (Crostini needs ensurepip). Install it and re-run:"
    echo "    sudo apt install -y python3-venv python3-full"
    exit 1
  }
fi
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r requirements.txt

if [ ! -d model ]; then
  echo "==> Vosk small English model (~40MB)…"
  command -v curl >/dev/null || { echo "curl missing — run: sudo apt install -y curl unzip"; exit 1; }
  curl -L -o model.zip "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip"
  unzip -q model.zip
  mv vosk-model-small-en-us-0.15 model
  rm -f model.zip
else
  echo "==> Vosk model already present."
fi

echo "==> systemd user service…"
mkdir -p ~/.config/systemd/user
cp ghost-wake.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ghost-wake.service
loginctl enable-linger "$USER" 2>/dev/null || echo "(enable-linger skipped — service still starts when you open a Linux app)"

echo
echo "Done. Status:  systemctl --user status ghost-wake"
echo "Logs:          journalctl --user -u ghost-wake -f"
echo "Say:           \"hey ghost, open example.com\""
echo
echo "If it errors about PortAudio, install the system lib:  sudo apt install -y libportaudio2"
