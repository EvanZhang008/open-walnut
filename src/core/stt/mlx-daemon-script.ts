/**
 * The mlx ASR daemon's Python source (fed over stdin by engine-mlx.ts, see
 * daemon-source.ts), and its revision.
 *
 * stdlib-only on purpose (http.server + json) so the only requirement on the
 * configured Python env is mlx-audio itself. ThreadingHTTPServer keeps health
 * checks responsive during a long generate(); the model itself is serialized
 * behind a lock (one GPU, no benefit to overlap).
 */

import { createHash } from 'node:crypto';

/**
 * The decoding-side loop guard: pure Python, no mlx, so a test can run it on
 * plain token lists (tests/core/stt-mlx-loop-guard.test.ts).
 *
 * 2026-11-22 (02:16 UTC): on a 102 s take whose speaker went quiet near the
 * end, the model fell into one filler syllable repeated over and over in the
 * last 30 s chunk and ran until the token cap: 3270 of them, 41 s of engine
 * time, with gen_lock held so the next dictation waited 38 s. Hearing the same
 * clip again gave a normal text once and the loop once.
 *
 * The guard stops such a loop inside decoding. When the tokens generated in
 * this chunk end with one unit of 1 to 8 tokens repeated many times in a row,
 * the first time it bans the token that would continue the cycle for that
 * step, so the model has to say something else (the end of the text, or the
 * next real words). The second time in the same chunk, the model is looping
 * again around whatever it said in between ("x x x ... y x x x ..." has a unit
 * too long to see), so only the end of the text is allowed: the chunk ends
 * there. Either way the text stays the engine's own output; nothing is cut
 * afterwards. Thresholds sit far above real speech (a stutter of one word, a
 * phrase said four times; the test lists them).
 */
export const LOOP_GUARD_PY = `
LOOP_MAX_PERIOD = 8

def loop_min_repeats(period):
    return 12 if period == 1 else 8 if period == 2 else 6

LOOP_SHORTEST = min(p * loop_min_repeats(p) for p in range(1, LOOP_MAX_PERIOD + 1))
LOOP_WINDOW = max(p * loop_min_repeats(p) for p in range(1, LOOP_MAX_PERIOD + 1))

def loop_ban(generated):
    """The token that would continue a degenerate repetition at the end of
    generated (a list of token ids), or None when there is none."""
    n = len(generated)
    for p in range(1, LOOP_MAX_PERIOD + 1):
        need = p * loop_min_repeats(p)
        if n < need:
            continue
        tail = generated[n - need:]
        if all(tail[i] == tail[i - p] for i in range(p, need)):
            return generated[n - p]
    return None

class LoopGuard:
    """Per-request state. A logits processor sees the whole token history of
    the current chunk (prompt included) and it grows by exactly one token per
    step; any other length means a new chunk (a new generate_step), so the
    generated part starts again from there. Only generated tokens are judged:
    the prompt's audio pads never count."""

    def __init__(self):
        self.start = 0
        self.last_len = -1
        self.fired = 0        # steps it acted on, this request
        self.chunk_fired = 0  # the same, this chunk

    def step(self, history_len, read_tail):
        """What to do with the next token: None (nothing), ("ban", t) (anything
        but t), or ("end", t) (only the end of the text; t is the token to ban
        when the end is not known)."""
        if history_len != self.last_len + 1:
            self.start = history_len
            self.chunk_fired = 0
        self.last_len = history_len
        generated = history_len - self.start
        if generated < LOOP_SHORTEST:
            return None
        token = loop_ban(read_tail(min(generated, LOOP_WINDOW)))
        if token is None:
            return None
        self.fired += 1
        self.chunk_fired += 1
        return ("ban" if self.chunk_fired == 1 else "end", token)
`;

export const MLX_SERVER_PY = `
import json, os, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_ID = sys.argv[1]
PORT = int(sys.argv[2])
IDLE_TTL_S = float(sys.argv[3]) if len(sys.argv) > 3 else 600.0
# A hash of this script, computed by the server that spawned us. A successor
# server adopts a warm daemon only when it runs the same script.
REV = sys.argv[4] if len(sys.argv) > 4 else ""
TMP_ROOT = os.path.realpath(tempfile.gettempdir())

from mlx_audio.stt.utils import load_model
model = load_model(MODEL_ID)
gen_lock = threading.Lock()
last_activity = time.time()
${LOOP_GUARD_PY}
# Guards made for the request in progress (filled under gen_lock).
_guards = []

def _eos_ids():
    """The model's end-of-text token ids, or [] when it does not say."""
    try:
        ids = model._eos_token_ids() if callable(getattr(model, "_eos_token_ids", None)) else None
        if not ids:
            tok = getattr(model, "_tokenizer", None) or getattr(model, "tokenizer", None)
            ids = getattr(tok, "eos_token_ids", None) or getattr(tok, "eos_token_id", None)
        if isinstance(ids, int):
            ids = [ids]
        return sorted(int(i) for i in (ids or []))
    except Exception:  # noqa: BLE001
        return []

EOS_IDS = _eos_ids()

def _guard_processor(guard):
    # One guard per generate(). The batched path (batch_size > 1, which this
    # daemon never asks for) hands it each sample's history in turn: the length
    # then never grows by one between calls, so it never acts there.
    def process(tokens, logits):
        try:
            if tokens.ndim != 1:
                return logits
            n = int(tokens.shape[0])
            action = guard.step(n, lambda k: tokens[n - k:].tolist())
            if action is None:
                return logits
            kind, token = action
            vocab = int(logits.shape[-1])
            if kind == "end" and EOS_IDS and all(0 <= e < vocab for e in EOS_IDS):
                logits[...] = -float("inf")
                for e in EOS_IDS:
                    logits[..., e] = 0.0
            elif 0 <= token < vocab:
                logits[..., token] = -float("inf")
        except Exception:  # noqa: BLE001 - a guard fault must never fail a dictation
            pass
        return logits
    return process

def _install_loop_guard():
    """Hook mlx-audio's logits-processor factory so every generate() that asks
    for a repetition penalty also gets a fresh loop guard. Returns None when
    installed, else why not (the daemon then runs without it)."""
    try:
        import inspect
        from mlx_audio.lm import sample_utils
        original = sample_utils.make_logits_processors
        if "repetition_penalty" not in inspect.signature(model.generate).parameters:
            return "generate() takes no repetition_penalty"
        def make_logits_processors(*args, **kwargs):
            # 1.0 is our marker (a no-op penalty): only a real one is built.
            if kwargs.get("repetition_penalty") == 1.0:
                kwargs.pop("repetition_penalty")
            processors = list(original(*args, **kwargs) or [])
            guard = LoopGuard()
            _guards.append(guard)
            return [_guard_processor(guard)] + processors
        sample_utils.make_logits_processors = make_logits_processors
        # Modules that imported the factory by name at load time.
        for mod in list(sys.modules.values()):
            if getattr(mod, "__name__", "").startswith("mlx_audio") and getattr(mod, "make_logits_processors", None) is original:
                mod.make_logits_processors = make_logits_processors
        return None
    except Exception as e:  # noqa: BLE001 - a newer mlx-audio must not stop the daemon
        return repr(e)

# Why the daemon runs without its guard, or None while it has one. Set again
# when a generate() never built a guard (a newer mlx-audio that stopped calling
# the factory). Only printed before READY: the spawning server closes our pipes
# after that, so the reason travels in the replies instead.
loop_guard_off = _install_loop_guard()
if loop_guard_off:
    print("loop guard not installed: " + loop_guard_off, flush=True)
elif not EOS_IDS:
    print("loop guard: the model names no end-of-text token, a second loop in a chunk is only banned", flush=True)

# The daemon deliberately OUTLIVES the node process that spawned it: walnut
# redeploys kill and restart the server many times a day, and dying with the
# parent meant every restart re-paid the ~2 GB model load — the single biggest
# cause of "dictation suddenly takes 15s". Instead the daemon sits on a fixed
# port, successor servers adopt it (see ensureServerRunning), and THIS timer —
# not a parent watchdog — bounds an orphan's life. Idle = no transcription for
# the TTL; a generation in progress never counts as idle.
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

    def do_GET(self):
        self._reply(200, {"status": "ok", "model": MODEL_ID, "rev": REV, "loopGuard": loop_guard_off is None})

    def do_POST(self):
        global last_activity, loop_guard_off
        # Lets a config change (different model) retire the previous daemon
        # cleanly even though no server holds its process handle anymore.
        if self.path == "/shutdown":
            self._reply(200, {"ok": True})
            threading.Thread(target=lambda: (time.sleep(0.2), os._exit(0))).start()
            return
        last_activity = time.time()
        try:
            n = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(n) or b"{}")
            wav = req.get("wav")
            # Only serve files under the temp dir (where our ffmpeg conversion
            # writes) — keeps a drive-by local POST from feeding it arbitrary paths.
            wav = os.path.realpath(wav) if wav else None
            if not wav or not wav.startswith(TMP_ROOT + os.sep) or not os.path.isfile(wav):
                self._reply(400, {"error": "missing or non-temp wav path"})
                return
            kwargs = {}
            # max_tokens must scale with the AUDIO LENGTH. Two failure modes bound it:
            # too low silently truncates long audio (mlx-audio's 8192 default), and
            # too high lets a degenerate repetition loop on a 30s dictation run for
            # many minutes while holding gen_lock — which starves every queued
            # request behind it (observed live 2026-08-28: one wedged generate froze
            # voice input entirely). ~32 tok/s of speech is 3-4x real zh-en density.
            # The loop guard is what ends such a loop early; this cap is the backstop.
            try:
                import wave
                with wave.open(wav, "rb") as wf:
                    dur_s = wf.getnframes() / (wf.getframerate() or 16000)
            except Exception:
                dur_s = 600.0
            cap = max(1024, min(int(dur_s * 32) + 256, 65536))
            req_max = int(req.get("max_tokens") or cap)
            kwargs["max_tokens"] = min(req_max, cap)
            kwargs["chunk_duration"] = float(req.get("chunk_duration") or 30.0)
            if req.get("language"):
                kwargs["language"] = req["language"]
            if req.get("system_prompt"):
                kwargs["system_prompt"] = req["system_prompt"]
            # A no-op penalty is what makes generate() build logits processors,
            # where the loop guard rides. "loop_guard": false runs without it.
            guarded = loop_guard_off is None and req.get("loop_guard", True) is not False
            if guarded:
                kwargs["repetition_penalty"] = 1.0
            t0 = time.time()
            with gen_lock:
                _guards.clear()
                out = model.generate(wav, **kwargs)
                built = len(_guards)
                fired = sum(g.fired for g in _guards)
                _guards.clear()
            if guarded and not built:
                loop_guard_off = "generate() built no logits processors, so the hook never ran"
            # Stamp at completion too: the idle countdown starts from the last
            # FINISHED request, not from when a long dictation began.
            last_activity = time.time()
            text = (getattr(out, "text", None) or "").strip()
            reply = {
                "text": text,
                "engineMs": int((time.time() - t0) * 1000),
                "tokens": getattr(out, "generation_tokens", None),
                # Decoding steps the guard acted on; None when it did not run.
                "loopGuard": fired if guarded and built else None,
            }
            if reply["loopGuard"] is None:
                reply["loopGuardOff"] = loop_guard_off or "turned off by the request"
            self._reply(200, reply)
        except Exception as e:  # noqa: BLE001 — daemon must answer, not die
            self._reply(500, {"error": str(e)})

ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
`;

/**
 * The script's revision, derived from its text so it can never be forgotten
 * when the script changes. Passed as argv[4] and answered on GET /: a warm
 * daemon left by an older server runs an older script, and is retired once
 * instead of adopted (identifyWalnutDaemon).
 */
export const MLX_DAEMON_REV = createHash('sha256').update(MLX_SERVER_PY).digest('hex').slice(0, 12);
