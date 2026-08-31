/**
 * MLX STT engine (Apple Silicon).
 *
 * Runs an mlx-audio ASR model (default: Qwen3-ASR) as a persistent local HTTP
 * daemon, so the model loads once and stays resident on the GPU — repeat
 * dictations skip the ~5s Python/model cold start. Mirrors the whisper-server
 * engine's lifecycle exactly: auto-start on first transcription, health-checked
 * reuse, idle TTL, shutdown() kill, singleton via getOrCreateEngine.
 *
 * The daemon is a small stdlib-only Python script (embedded below, written to
 * the temp dir at spawn). It needs a Python env with `mlx-audio` installed —
 * configured via stt.mlx_python_path. Requests carry a WAV path (the file is
 * produced by our own ffmpeg conversion in a private temp dir), never raw audio,
 * and the server binds 127.0.0.1 only.
 *
 * Vocabulary biasing: mlx-audio's CLI `--context` flag is silently DROPPED for
 * Qwen3-ASR (generate.py filters kwargs against the model signature, and
 * qwen3_asr.generate takes `system_prompt`/`hotwords`, not `context`). The
 * daemon passes the vocab prompt as `system_prompt`, which is the field that
 * actually reaches the model.
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '../../logging/index.js';
import { sttSpawnEnv } from './spawn-env.js';
import { convertToWav, cleanupTempFile, isFfmpegAvailable } from './audio-convert.js';
import type { SttEngine, SttRequest, SttResult } from './types.js';

const execFileAsync = promisify(execFile);

export interface MlxEngineConfig {
  pythonPath: string;   // python interpreter with mlx-audio installed
  model?: string;       // HF model id or local path (default: Qwen3-ASR 8-bit)
  port?: number;        // daemon port (default: auto-pick)
  idleTtlMs?: number;   // kill daemon after inactivity (default: 10 min)
}

export const DEFAULT_MLX_MODEL = 'mlx-community/Qwen3-ASR-1.7B-8bit';
const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000;
// Model load from local HF cache is ~5-15s; a first-ever run also downloads the
// weights (~2 GB), so the startup wait is generous rather than tight.
const STARTUP_TIMEOUT_MS = 120_000;
const HEALTH_CHECK_INTERVAL_MS = 500;
// Fixed default port so that SUCCESSIVE walnut servers (redeploys, ephemeral
// test children) find and adopt one already-warm daemon instead of each paying
// the model load. 7893 sits next to walnut's other fixed ports (7891 sessions).
const DEFAULT_MLX_PORT = 7893;

/**
 * The daemon script. stdlib-only on purpose (http.server + json) so the only
 * requirement on the configured Python env is mlx-audio itself.
 * ThreadingHTTPServer keeps health checks responsive during a long generate();
 * the model itself is serialized behind a lock (one GPU, no benefit to overlap).
 */
const MLX_SERVER_PY = `
import json, os, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_ID = sys.argv[1]
PORT = int(sys.argv[2])
IDLE_TTL_S = float(sys.argv[3]) if len(sys.argv) > 3 else 3600.0
TMP_ROOT = os.path.realpath(tempfile.gettempdir())

from mlx_audio.stt.utils import load_model
model = load_model(MODEL_ID)
gen_lock = threading.Lock()
last_activity = time.time()

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
        self._reply(200, {"status": "ok", "model": MODEL_ID})

    def do_POST(self):
        global last_activity
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
            t0 = time.time()
            with gen_lock:
                out = model.generate(wav, **kwargs)
            # Stamp at completion too: the idle countdown starts from the last
            # FINISHED request, not from when a long dictation began.
            last_activity = time.time()
            text = (getattr(out, "text", None) or "").strip()
            self._reply(200, {"text": text, "engineMs": int((time.time() - t0) * 1000)})
        except Exception as e:  # noqa: BLE001 — daemon must answer, not die
            self._reply(500, {"error": str(e)})

ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
`;

/**
 * Map an ISO 639-1 hint to the language names mlx-audio's Qwen3-ASR expects.
 * Unknown/empty hints are omitted → the model auto-detects.
 */
export function mlxLanguageName(iso?: string): string | undefined {
  if (!iso) return undefined;
  const map: Record<string, string> = {
    zh: 'Chinese', en: 'English', ja: 'Japanese', ko: 'Korean',
    es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
    pt: 'Portuguese', ru: 'Russian', ar: 'Arabic', hi: 'Hindi',
    id: 'Indonesian', vi: 'Vietnamese', th: 'Thai', tr: 'Turkish',
    nl: 'Dutch', pl: 'Polish', uk: 'Ukrainian',
  };
  return map[iso.toLowerCase()];
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

/** Find an available port by binding to 0 and releasing immediately. */
async function findFreePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export function createMlxEngine(cfg: MlxEngineConfig): SttEngine {
  const model = cfg.model || DEFAULT_MLX_MODEL;
  const idleTtlMs = cfg.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  // serverProcess is null while serving through an ADOPTED daemon (one spawned
  // by a previous walnut server on the shared port) — the daemon self-manages
  // its idle TTL, so not holding the process handle is fine.
  let serverProcess: ChildProcess | null = null;
  let serverPort: number | null = null;
  // Startup is long (model load 5-120s) and the socket only binds at the END of
  // it — so concurrent transcribe() calls (primary + shadow are now routine)
  // MUST share one in-flight start instead of health-checking a not-yet-listening
  // child, "restarting" it, and killing each other's daemons.
  let startingPromise: Promise<number> | null = null;
  // Requests currently against the daemon — the idle TTL must not fire while
  // one is in flight (a dictation longer than the TTL would be killed mid-run).
  let inFlight = 0;
  // Private per-instance dir for the daemon script: a fixed name in the shared
  // /tmp would be a symlink/replace target for other local users (the ffmpeg
  // temp files in audio-convert.ts use random names for the same reason).
  let scriptDir: string | null = null;
  // Import check is ~1s of Python startup — cache SUCCESS only, so isAvailable()
  // stays cheap once probed but `pip install mlx-audio` is picked up without a
  // walnut restart after a failed probe.
  let mlxImportOk = false;

  /**
   * Retire the daemon. When `only` is given, no-op unless it is still the CURRENT
   * child — a stale caller (e.g. a failed startup racing a successful restart)
   * must never take down its successor. An adopted daemon (no process handle)
   * gets an HTTP shutdown instead of a signal.
   */
  function killServer(only?: ChildProcess) {
    if (only && serverProcess !== only) return;
    if (serverProcess) {
      log.stt.info(`Killing mlx daemon (pid=${serverProcess.pid})`);
      serverProcess.kill('SIGTERM');
      const proc = serverProcess;
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
    } else if (serverPort && !only) {
      log.stt.info(`Shutting down adopted mlx daemon on :${serverPort}`);
      void fetch(`http://127.0.0.1:${serverPort}/shutdown`, {
        method: 'POST', signal: AbortSignal.timeout(2000),
      }).catch(() => {});
    }
    serverProcess = null;
    serverPort = null;
  }

  /**
   * Is a healthy walnut mlx daemon (for OUR model) already listening on `port`?
   * Distinguishes three cases: ours (adopt), a walnut daemon for a different
   * model (retire it, then spawn), and anything else (foreign — leave alone).
   */
  async function probeDaemon(port: number): Promise<'ours' | 'other-model' | 'none' | 'foreign'> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return 'foreign';
      const json = await res.json() as { status?: string; model?: string };
      if (json.status !== 'ok' || !json.model) return 'foreign';
      return json.model === model ? 'ours' : 'other-model';
    } catch {
      return 'none';
    }
  }

  async function waitForReady(proc: ChildProcess, port: number, timeoutMs: number): Promise<'ready' | 'exited' | 'timeout'> {
    const deadline = Date.now() + timeoutMs;
    let exited = false;
    proc.once('exit', () => { exited = true; });
    proc.once('error', () => { exited = true; });
    while (Date.now() < deadline) {
      if (exited) return 'exited';
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(Math.max(1, Math.min(2_000, deadline - Date.now()))),
        });
        if (res.ok) return 'ready';
      } catch {
        // Not ready yet
      }
      await new Promise(r => setTimeout(r, HEALTH_CHECK_INTERVAL_MS));
    }
    return exited ? 'exited' : 'timeout';
  }

  async function ensureServerRunning(): Promise<number> {
    // A start is already in flight — join it. Checked BEFORE the health probe:
    // during startup serverProcess is set but nothing listens yet, and a probe
    // would misread that as a dead daemon and kill it.
    if (startingPromise) return startingPromise;

    if (serverPort) {
      const probed = serverProcess ?? undefined;
      try {
        const res = await fetch(`http://127.0.0.1:${serverPort}/`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return serverPort;
        throw new Error(`health ${res.status}`);
      } catch {
        // A daemon mid-generation can hold the GIL long enough to miss the 2s
        // probe. If a request is in flight it is BUSY, not dead — killing it
        // here would abort someone else's transcription. Queue behind it.
        if (inFlight > 0) {
          log.stt.info('mlx daemon busy (health probe timed out with requests in flight) — queuing');
          return serverPort;
        }
        log.stt.warn('mlx daemon health check failed — restarting');
        killServer(probed);
      }
    }

    if (!startingPromise) {
      startingPromise = startServer().finally(() => { startingPromise = null; });
    }
    return startingPromise;
  }

  async function startServer(): Promise<number> {
    let port = cfg.port ?? DEFAULT_MLX_PORT;

    // A previous walnut server (we redeploy many times a day) may have left a
    // warm daemon on the shared port. Adopting it skips the ~2 GB model load —
    // THE fix for dictation stalling after every deploy. A daemon for a
    // different model is retired first; a non-walnut listener means the port is
    // simply taken, so fall back to an exclusive one.
    const found = await probeDaemon(port);
    if (found === 'ours') {
      serverProcess = null;
      serverPort = port;
      log.stt.info(`Adopted existing mlx daemon on :${port} (model=${model})`);
      return port;
    }
    if (found === 'other-model') {
      log.stt.info(`Retiring mlx daemon on :${port} (different model)`);
      await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) }).catch(() => {});
      await new Promise(r => setTimeout(r, 500));
    } else if (found === 'foreign') {
      log.stt.warn(`Port ${port} is held by a non-walnut process — using an ephemeral port`);
      port = await findFreePort();
    }
    if (!scriptDir) {
      const { mkdtemp } = await import('node:fs/promises');
      scriptDir = await mkdtemp(join(tmpdir(), 'walnut-mlx-'));
    }
    const scriptPath = join(scriptDir, 'server.py');
    await writeFile(scriptPath, MLX_SERVER_PY);

    log.stt.info(`Starting mlx daemon: ${cfg.pythonPath} ${scriptPath} ${model} :${port}`);
    // detached: the server often runs as a launchd job, and launchd kills the
    // job's whole process group on `launchctl remove` (every redeploy). A
    // daemon in its own group survives that, which is the point of adoption.
    const proc = spawn(cfg.pythonPath, [scriptPath, model, String(port), String(idleTtlMs / 1000)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: sttSpawnEnv(),
    });

    const outputTail: string[] = [];
    const captureOutput = (d: Buffer) => {
      const line = d.toString().trim();
      if (!line) return;
      log.stt.debug(`[mlx-daemon] ${line}`);
      outputTail.push(...line.split('\n'));
      if (outputTail.length > 20) outputTail.splice(0, outputTail.length - 20);
    };
    proc.stdout?.on('data', captureOutput);
    proc.stderr?.on('data', captureOutput);

    proc.on('exit', (code, signal) => {
      log.stt.info(`mlx daemon exited (code=${code}, signal=${signal})`);
      if (serverProcess === proc) {
        serverProcess = null;
        serverPort = null;
      }
    });
    proc.on('error', (err) => {
      log.stt.error(`mlx daemon spawn error: ${err.message}`);
      if (serverProcess === proc) {
        serverProcess = null;
        serverPort = null;
      }
    });

    serverProcess = proc;
    serverPort = port;

    const outcome = await waitForReady(proc, port, STARTUP_TIMEOUT_MS);
    if (outcome === 'exited' && (await probeDaemon(port)) === 'ours') {
      // Two walnut servers raced a cold start on the shared port; the other one
      // won the bind and its daemon is healthy — adopt instead of failing.
      serverProcess = null;
      serverPort = port;
      log.stt.info(`Lost the mlx daemon bind race — adopted the winner on :${port}`);
      return port;
    }
    if (outcome !== 'ready') {
      killServer(proc);
      const diagnostic = outputTail
        .filter(l => /error|not found|failed|cannot|unable|no such|traceback/i.test(l))
        .slice(-3)
        .join('; ');
      const reason = outcome === 'exited'
        ? `mlx daemon exited during startup${diagnostic ? `: ${diagnostic}` : ''}`
        : `mlx daemon failed to start within ${STARTUP_TIMEOUT_MS / 1000}s${diagnostic ? ` (${diagnostic})` : ''}`;
      log.stt.error(`${reason}${outputTail.length ? ` | tail: ${outputTail.slice(-5).join(' | ')}` : ''}`);
      throw new Error(reason);
    }

    log.stt.info(`mlx daemon ready on port ${port} (pid=${proc.pid}, model=${model})`);
    // Startup diagnostics are done; release the pipes and the handle so the
    // daemon neither blocks this process's exit nor dies with it.
    proc.stdout?.destroy();
    proc.stderr?.destroy();
    proc.unref();
    return port;
  }

  // Deliberately NO process-exit cleanup: the daemon is meant to outlive this
  // server so the next deploy adopts it warm. Its own idle TTL bounds orphans.

  return {
    name: 'mlx',

    async warmup() {
      await ensureServerRunning();
    },

    shutdown() {
      // Config changed (model/TTL/port) — the daemon really is stale, retire it.
      killServer();
      if (scriptDir) {
        void import('node:fs/promises').then(({ rm }) =>
          rm(scriptDir!, { recursive: true, force: true })).catch(() => {});
        scriptDir = null;
      }
    },

    async isAvailable() {
      if (!(await fileExists(cfg.pythonPath))) {
        return { available: false, error: `Python interpreter not found: ${cfg.pythonPath}` };
      }
      if (!mlxImportOk) {
        try {
          await execFileAsync(cfg.pythonPath, ['-c', 'import mlx_audio'], { timeout: 30_000, env: sttSpawnEnv() });
          mlxImportOk = true;
        } catch {
          return { available: false, error: `mlx-audio not installed in ${cfg.pythonPath} (pip install mlx-audio)` };
        }
      }
      if (!(await isFfmpegAvailable())) {
        return { available: false, error: 'ffmpeg is required for audio conversion but not found' };
      }
      return { available: true };
    },

    async transcribe(req: SttRequest): Promise<SttResult> {
      const t0 = Date.now();
      const port = await ensureServerRunning();
      const wavPath = await convertToWav(req.audio, req.format);
      inFlight++; // after convertToWav — a convert throw must not leak the counter
      try {
        // Timeout scales with audio length (16kHz mono s16le = 32000 bytes/s):
        // transcription runs ~15x realtime on Metal, so 8x realtime + 90s floor
        // is generous headroom without letting a dictation hang for 15 minutes.
        const wavBytes = (await stat(wavPath)).size;
        const timeoutMs = Math.round(Math.min(15 * 60_000, Math.max(90_000, (wavBytes / 32_000) * 8_000)));
        log.stt.info(`Sending ${wavPath} to mlx daemon :${port} (model=${model}, timeout=${Math.round(timeoutMs / 1000)}s)`);
        const res = await fetch(`http://127.0.0.1:${port}/inference`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            wav: wavPath,
            language: mlxLanguageName(req.language),
            system_prompt: req.prompt || undefined,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          let detail = '';
          try { detail = ((await res.json()) as { error?: string }).error ?? ''; } catch {}
          throw new Error(`mlx daemon returned ${res.status}${detail ? `: ${detail}` : ''}`);
        }
        const json = await res.json() as { text?: string };
        return { text: (json.text ?? '').trim(), durationMs: Date.now() - t0 };
      } finally {
        inFlight--;
        await cleanupTempFile(wavPath);
      }
    },
  };
}
