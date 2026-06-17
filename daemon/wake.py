#!/usr/bin/env python3
"""
Ghost-Prime wake-word daemon — always-listening, runs as a background service at Crostini start
(NOT tied to the app). Offline + free: uses Vosk for on-device speech, matches a wake phrase, then
captures the following command and hands it to Ghost-Prime via the app's local /task endpoint
(the same channel the right-click "Ask Ghost" uses). If the app isn't running, it launches it first.

Say e.g. "hey ghost, open discord" — or just "hey ghost" and then the command in the next breath.

Config via env (all optional; defaults match the app's .env defaults):
  GHOST_WAKE_PHRASE   wake words to listen for           (default: "ghost")
  GHOST_BRIDGE_URL    app bridge base URL                (default: http://127.0.0.1:8731)
  GHOST_BRIDGE_TOKEN  shared token                       (default: ghost-local)
  GHOST_LAUNCH_CMD    how to start the app if it's down  (default: gtk-launch ghost-prime)
  GHOST_VOSK_MODEL    path to a Vosk model dir           (default: <this dir>/model)
  GHOST_WAKE_DEVICE   input device index/name for sounddevice (default: system default)
"""
import json
import os
import queue
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PHRASE = os.environ.get("GHOST_WAKE_PHRASE", "ghost").lower().strip()
BRIDGE = os.environ.get("GHOST_BRIDGE_URL", "http://127.0.0.1:8731").rstrip("/")
TOKEN = os.environ.get("GHOST_BRIDGE_TOKEN", "ghost-local")
LAUNCH_CMD = os.environ.get("GHOST_LAUNCH_CMD", "gtk-launch ghost-prime")
MODEL_DIR = os.environ.get("GHOST_VOSK_MODEL", os.path.join(HERE, "model"))
DEVICE = os.environ.get("GHOST_WAKE_DEVICE") or None
FOLLOWUP = float(os.environ.get("GHOST_WAKE_FOLLOWUP_SECS", "0") or 0)  # keep listening N s after a command (0 = one-shot)
SAMPLE_RATE = 16000


def log(*a):
    print("[ghost-wake]", *a, flush=True)


def post_task(prompt):
    """Send the spoken command to the app. Returns True on success."""
    body = json.dumps({"prompt": prompt}).encode()
    req = urllib.request.Request(
        f"{BRIDGE}/task?token={TOKEN}", data=body, headers={"Content-Type": "application/json"}
    )
    urllib.request.urlopen(req, timeout=5).read()
    return True


def app_is_up():
    try:
        urllib.request.urlopen(f"{BRIDGE}/ping?token={TOKEN}", timeout=2).read()
        return True
    except Exception:
        return False


def ensure_app():
    """Launch Ghost-Prime if its bridge isn't answering, and wait for it to come up."""
    if app_is_up():
        return True
    log("app not running — launching:", LAUNCH_CMD)
    try:
        subprocess.Popen(LAUNCH_CMD, shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        log("launch failed:", e)
        return False
    for _ in range(40):  # up to ~20s for the app + bridge to start
        if app_is_up():
            return True
        time.sleep(0.5)
    return False


def trigger(command):
    command = command.strip()
    if not command:
        return
    log("heard command:", repr(command))
    ensure_app()
    try:
        post_task(command)
        log("→ sent to Ghost-Prime")
    except urllib.error.URLError as e:
        log("could not reach the app:", e)
    except Exception as e:
        log("send error:", e)


def main():
    try:
        import sounddevice as sd
        from vosk import KaldiRecognizer, Model
    except ImportError:
        log("missing deps. Run: pip install -r daemon/requirements.txt   (and download a Vosk model)")
        sys.exit(1)

    if not os.path.isdir(MODEL_DIR):
        log(f"no Vosk model at {MODEL_DIR}. Run daemon/install.sh, or set GHOST_VOSK_MODEL.")
        sys.exit(1)

    log(f"loading model {MODEL_DIR} …")
    model = Model(MODEL_DIR)
    rec = KaldiRecognizer(model, SAMPLE_RATE)
    rec.SetWords(False)

    q = queue.Queue()

    def on_audio(indata, frames, t, status):
        if status:
            log("audio status:", status)
        q.put(bytes(indata))

    armed_until = 0.0  # while now < armed_until, the next utterance is taken as a command (no wake phrase)
    log(f'listening for "{PHRASE}" …')
    with sd.RawInputStream(samplerate=SAMPLE_RATE, blocksize=8000, dtype="int16", channels=1, device=DEVICE, callback=on_audio):
        while True:
            data = q.get()
            if not rec.AcceptWaveform(data):
                continue
            text = (json.loads(rec.Result()).get("text") or "").lower().strip()
            if not text:
                continue
            if time.time() < armed_until:
                trigger(text)
                with q.mutex:
                    q.queue.clear()  # drop audio buffered while we were busy → no stale re-triggers
                armed_until = time.time() + FOLLOWUP if FOLLOWUP > 0 else 0.0
            elif PHRASE in text:
                after = text.split(PHRASE, 1)[1].strip()  # the command after the wake phrase, if any
                if after:
                    trigger(after)
                    with q.mutex:
                        q.queue.clear()
                    armed_until = time.time() + FOLLOWUP if FOLLOWUP > 0 else 0.0
                else:
                    armed_until = time.time() + 10  # woke with no command — wait up to 10s for it
                    log("woke — waiting for your command…")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
