/**
 * The local voice daemon's Python source (fed over stdin by engine-qwen.ts
 * through src/core/stt/python-daemon.ts), and its revision.
 *
 * Qwen3-TTS through mlx-audio: the model loads once, says one short sentence
 * to warm up (the first generate after a load takes about 7 s on an M4 Pro, the
 * next ones a fraction of a second), and only then binds its port, so "ready"
 * means warm. Each POST /speak turns one piece into 16-bit mono WAV, whole;
 * with `stream: true` it answers 200 as soon as the piece's generation starts
 * and writes each chunk as the model makes it: `audio/L16; rate=<rate>;
 * channels=1` (RFC 2586: signed 16-bit big-endian PCM, no header) in HTTP/1.1
 * chunks. A piece made whole ends with the last (empty) chunk; one cut off (a
 * cancel, its deadline, a model error) ends without it, so the reader's fetch
 * fails instead of taking a shortened piece for a whole one. A reader that goes
 * away stops the generation at the next chunk (the write fails).
 *
 * stdlib only beyond mlx-audio itself: the samples are packed with `array`
 * from the array's `tolist()`, which also reads a bfloat16 array, and keeps
 * the script runnable in a test against a fake `mlx_audio` package. A
 * ThreadingHTTPServer answers health checks during a generate; the model is
 * serialized behind a lock (one GPU). A request is cut off at its deadline or
 * by POST /cancel between two streamed chunks, so a piece nobody waits for any
 * more does not hold the lock for the next one.
 *
 * Every POST must be JSON, carry no Origin and name 127.0.0.1 or localhost as
 * its Host: a web page can send none of that (a cross-site "no-cors" POST is
 * text/plain or a form, and a browser always adds Origin to a POST), so no site
 * the person visits can make the Mac speak, cancel a piece or stop the daemon.
 */

import { createHash } from 'node:crypto';

export const QWEN_TTS_PY = `
import array, io, json, os, sys, threading, time, wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_ID = sys.argv[1]
PORT = int(sys.argv[2])
IDLE_TTL_S = float(sys.argv[3]) if len(sys.argv) > 3 else 600.0
# A hash of this script: a successor server adopts a warm daemon only when it runs the same one.
REV = sys.argv[4] if len(sys.argv) > 4 else ""
WARM_VOICE = sys.argv[5] if len(sys.argv) > 5 else ""
MAX_CHARS = 2000

from mlx_audio.tts.utils import load_model
model = load_model(MODEL_ID)
SAMPLE_RATE = int(getattr(model, "sample_rate", 0) or 24000)
gen_lock = threading.Lock()
last_activity = time.time()
# Request ids a client stopped waiting for, with when (pruned after a minute).
cancelled = {}
cancel_lock = threading.Lock()

def _voices():
    for src in (model, getattr(model, "config", None)):
        v = getattr(src, "speakers", None) if src is not None else None
        if isinstance(v, dict):
            return sorted(str(k) for k in v)
        if isinstance(v, (list, tuple)):
            return [str(k) for k in v]
    return None

VOICES = _voices()

def _is_cancelled(req_id):
    with cancel_lock:
        return bool(req_id) and req_id in cancelled

def pcm16(samples, big=False):
    """Float samples in [-1, 1] to 16-bit PCM bytes: little-endian for WAV, big-endian for audio/L16."""
    pcm = array.array("h", (int(max(-1.0, min(1.0, x)) * 32767.0) for x in samples))
    if (sys.byteorder == "big") != big:
        pcm.byteswap()
    return pcm.tobytes()

def to_wav(samples):
    """Float samples in [-1, 1] to 16-bit mono WAV bytes."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm16(samples))
    return buf.getvalue()

def _flat(r):
    audio = getattr(r, "audio", None)
    if audio is None:
        return []
    flat = audio.tolist()
    while flat and isinstance(flat[0], list):
        flat = [x for row in flat for x in row]
    return flat

def _chunks(text, voice, lang_code):
    # mlx-audio makes every chunk the same size (int(interval * 12.5) codec tokens): no smaller first one.
    return model.generate(text=text, voice=voice or None, lang_code=lang_code, stream=True, streaming_interval=0.32)

def _stopped(req_id, deadline):
    if _is_cancelled(req_id):
        return "cancelled"
    if deadline is not None and time.time() > deadline:
        return "deadline"
    return None

def synthesize(text, voice, lang_code, req_id="", deadline=None):
    """WAV bytes of the whole piece, or (None, why) when it was cut off."""
    samples = []
    for r in _chunks(text, voice, lang_code):
        samples.extend(_flat(r))
        why = _stopped(req_id, deadline)
        if why:
            return None, why
    return to_wav(samples), None

def _write_timeout(deadline):
    """How long one write may block: at most 15 s, and not much past the piece's deadline."""
    left = 15.0 if deadline is None else deadline - time.time()
    return max(0.5, min(15.0, left))

def stream_speech(handler, text, voice, lang_code, req_id, deadline):
    """Answer 200 now and write the piece as audio/L16 chunks as they are made: None when whole, else why it stopped."""
    handler.protocol_version = "HTTP/1.1"  # chunked transfer needs it; Connection: close ends the exchange
    handler.send_response(200)
    handler.send_header("Content-Type", "audio/L16; rate=%d; channels=1" % SAMPLE_RATE)
    handler.send_header("Transfer-Encoding", "chunked")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Connection", "close")
    handler.end_headers()
    out = handler.wfile
    gen = _chunks(text, voice, lang_code)
    try:
        for r in gen:
            flat = _flat(r)
            if flat:
                data = pcm16(flat, big=True)
                # A reader that stops reading cannot hold the model past the piece's deadline.
                handler.connection.settimeout(_write_timeout(deadline))
                out.write(b"%x\\r\\n" % len(data) + data + b"\\r\\n")
                out.flush()
            why = _stopped(req_id, deadline)
            if why:
                return why
        out.write(b"0\\r\\n\\r\\n")
        out.flush()
        return None
    except OSError:
        return "the reader went away"
    except Exception as e:  # noqa: BLE001 - the headers are out: end the stream short, never write JSON into it
        print("stream failed: " + repr(e)[:300], flush=True)
        return "model error"
    finally:
        try:
            gen.close()
        except Exception:  # noqa: BLE001
            pass

# Warm up before binding: the first generate after a load is the slow one.
t0 = time.time()
try:
    with gen_lock:
        synthesize("\\u4f60\\u597d\\u3002", WARM_VOICE, "zh")
    print("warm-up took %.1fs" % (time.time() - t0), flush=True)
except Exception as e:  # noqa: BLE001 - a failed warm-up is reported by the first real request
    print("warm-up failed: " + repr(e)[:300], flush=True)

# Like the speech daemon, this one OUTLIVES the server that spawned it, so the
# next deploy adopts it warm; this timer bounds an orphan's life.
def _watch_idle():
    while True:
        time.sleep(15)
        if not gen_lock.locked() and time.time() - last_activity > IDLE_TTL_S:
            os._exit(0)

threading.Thread(target=_watch_idle, daemon=True).start()
print("READY", flush=True)

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(n) or b"{}")

    def _foreign(self):
        """True for a POST a web page could have sent (see the header of qwen-daemon-script.ts)."""
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        host = self.headers.get("Host") or ""
        return ctype != "application/json" or self.headers.get("Origin") is not None \
            or host not in ("127.0.0.1:%d" % PORT, "localhost:%d" % PORT)

    def do_GET(self):
        self._reply(200, {"status": "ok", "model": MODEL_ID, "rev": REV, "role": "tts", "sampleRate": SAMPLE_RATE, "voices": VOICES})

    def do_POST(self):
        global last_activity
        if self._foreign():
            self._reply(403, {"error": "only a local JSON request with no Origin"})
            return
        if self.path == "/shutdown":
            self._reply(200, {"ok": True})
            threading.Thread(target=lambda: (time.sleep(0.2), os._exit(0))).start()
            return
        if self.path == "/cancel":
            try:
                req_id = str(self._body().get("id") or "")
            except Exception:  # noqa: BLE001
                req_id = ""
            now = time.time()
            with cancel_lock:
                for k in [k for k, at in cancelled.items() if now - at > 60]:
                    del cancelled[k]
                if req_id:
                    cancelled[req_id] = now
            self._reply(200, {"ok": True})
            return
        if self.path != "/speak":
            self._reply(404, {"error": "unknown path"})
            return
        last_activity = time.time()
        try:
            req = self._body()
            text = (req.get("text") or "").strip()
            if not text or len(text) > MAX_CHARS:
                self._reply(400, {"error": "text must be 1 to %d characters" % MAX_CHARS})
                return
            req_id = str(req.get("id") or "")
            deadline_ms = float(req.get("deadline_ms") or 30000)
            deadline = time.time() + min(deadline_ms, 120000) / 1000.0
            stream = req.get("stream") is True
            t0 = time.time()
            streamed = False
            with gen_lock:
                if _is_cancelled(req_id) or time.time() > deadline:
                    wav, why = None, "cancelled before it started"
                elif stream:
                    streamed = True
                    wav, why = None, stream_speech(self, text, req.get("voice") or "", req.get("lang_code") or "zh", req_id, deadline)
                else:
                    wav, why = synthesize(text, req.get("voice") or "", req.get("lang_code") or "zh", req_id, deadline)
            last_activity = time.time()
            with cancel_lock:
                cancelled.pop(req_id, None)
            if streamed:
                # The answer is out (whole, or ended short so the reader sees it cut); nothing more to write.
                self.close_connection = True
                return
            if wav is None:
                self._reply(408, {"error": "stopped: " + why})
                return
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav)))
            self.send_header("X-Engine-Ms", str(int((time.time() - t0) * 1000)))
            self.end_headers()
            self.wfile.write(wav)
        except Exception as e:  # noqa: BLE001 - the daemon must answer, not die
            if self.protocol_version == "HTTP/1.1":
                return  # a stream already answered: no JSON into it
            try:
                self._reply(500, {"error": str(e)[:500]})
            except Exception:  # noqa: BLE001 - the client already went away
                pass

ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
`;

/** The script's revision, derived from its text so a changed script is never adopted stale. */
export const QWEN_TTS_REV = createHash('sha256').update(QWEN_TTS_PY).digest('hex').slice(0, 12);
