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
PARENT_PID = int(sys.argv[3]) if len(sys.argv) > 3 else 0
TMP_ROOT = os.path.realpath(tempfile.gettempdir())

# Die with the parent: an abnormal node exit (SIGKILL/OOM) skips the JS cleanup
# handlers, and a ~2 GB orphan daemon would otherwise live forever (and squat a
# configured fixed port). kill(pid, 0) is a liveness probe, not a signal.
def _watch_parent():
    while True:
        time.sleep(5)
        try:
            os.kill(PARENT_PID, 0)
        except OSError:
            os._exit(0)

if PARENT_PID:
    threading.Thread(target=_watch_parent, daemon=True).start()

from mlx_audio.stt.utils import load_model
model = load_model(MODEL_ID)
gen_lock = threading.Lock()
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
            # Guard against silent truncation on long audio: mlx-audio's default
            # max_tokens (8192) stops mid-file without any error.
            kwargs["max_tokens"] = int(req.get("max_tokens") or 65536)
            kwargs["chunk_duration"] = float(req.get("chunk_duration") or 30.0)
            if req.get("language"):
                kwargs["language"] = req["language"]
            if req.get("system_prompt"):
                kwargs["system_prompt"] = req["system_prompt"]
            t0 = time.time()
            with gen_lock:
                out = model.generate(wav, **kwargs)
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
  let serverProcess: ChildProcess | null = null;
  let serverPort: number | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
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

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (inFlight > 0) { resetIdleTimer(); return; } // never kill mid-transcription
      log.stt.info(`mlx daemon idle for ${idleTtlMs / 1000}s — shutting down to free memory`);
      killServer();
    }, idleTtlMs);
  }

  /**
   * Kill the daemon. When `only` is given, no-op unless it is still the CURRENT
   * child — a stale caller (e.g. a failed startup racing a successful restart)
   * must never take down its successor.
   */
  function killServer(only?: ChildProcess) {
    if (only && serverProcess !== only) return;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (serverProcess) {
      log.stt.info(`Killing mlx daemon (pid=${serverProcess.pid})`);
      serverProcess.kill('SIGTERM');
      const proc = serverProcess;
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
      serverProcess = null;
      serverPort = null;
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

    if (serverProcess && serverPort) {
      const probed = serverProcess;
      try {
        const res = await fetch(`http://127.0.0.1:${serverPort}/`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          resetIdleTimer();
          return serverPort;
        }
      } catch {
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
    const port = cfg.port ?? await findFreePort();
    if (!scriptDir) {
      const { mkdtemp } = await import('node:fs/promises');
      scriptDir = await mkdtemp(join(tmpdir(), 'walnut-mlx-'));
    }
    const scriptPath = join(scriptDir, 'server.py');
    await writeFile(scriptPath, MLX_SERVER_PY);

    log.stt.info(`Starting mlx daemon: ${cfg.pythonPath} ${scriptPath} ${model} :${port}`);
    const proc = spawn(cfg.pythonPath, [scriptPath, model, String(port), String(process.pid)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
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
    resetIdleTimer();
    return port;
  }

  const cleanup = () => killServer();
  process.on('exit', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  return {
    name: 'mlx',

    shutdown() {
      killServer();
      if (scriptDir) {
        void import('node:fs/promises').then(({ rm }) =>
          rm(scriptDir!, { recursive: true, force: true })).catch(() => {});
        scriptDir = null;
      }
      process.removeListener('exit', cleanup);
      process.removeListener('SIGTERM', cleanup);
      process.removeListener('SIGINT', cleanup);
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
        log.stt.info(`Sending ${wavPath} to mlx daemon :${port} (model=${model})`);
        const res = await fetch(`http://127.0.0.1:${port}/inference`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            wav: wavPath,
            language: mlxLanguageName(req.language),
            system_prompt: req.prompt || undefined,
          }),
          // Generous but finite: a wedged generate() must not hang the caller's
          // HTTP request forever. Long recordings run ~15x realtime on Metal.
          signal: AbortSignal.timeout(15 * 60_000),
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
        // Re-arm the idle TTL at request END too, so the countdown starts from
        // the last completed request rather than its start.
        if (serverProcess) resetIdleTimer();
      }
    },
  };
}
