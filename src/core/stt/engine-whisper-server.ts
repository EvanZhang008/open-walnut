/**
 * whisper-server STT engine.
 *
 * Auto-starts whisper-server as a background HTTP daemon on first transcription.
 * The model stays loaded in GPU/memory — subsequent calls skip the ~2-3s model load.
 * An idle TTL auto-kills the server after inactivity to free ~1.6 GB RAM.
 *
 * IMPORTANT — singleton usage:
 * This engine MUST be used through the singleton cache in index.ts (getOrCreateEngine).
 * Each instance spawns a daemon process that loads a ~1.6 GB model. Creating multiple
 * instances will spawn multiple daemons and OOM-crash the machine. The singleton cache
 * ensures exactly one daemon exists. When the user switches engine/model, the old
 * instance's shutdown() is called to kill the daemon before a new one is created.
 *
 * Lifecycle:
 *   1. First transcribe() call → spawns whisper-server on a free port
 *   2. Subsequent calls → reuses running daemon (health-checked first)
 *   3. Idle for idleTtlMs → daemon auto-killed to free RAM
 *   4. shutdown() called → daemon killed, signal handlers removed
 *   5. Node process exits → cleanup handler kills daemon
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { log } from '../../logging/index.js';
import { sttSpawnEnv } from './spawn-env.js';
import { isFfmpegAvailable } from './audio-convert.js';
import type { SttEngine, SttRequest, SttResult } from './types.js';

const execFileAsync = promisify(execFile);

interface WhisperServerConfig {
  binaryPath: string;     // path to whisper-server binary
  modelPath: string;      // path to ggml model file
  vadModelPath?: string;  // path to Silero VAD model
  prompt?: string;        // domain words to bias decoder
  port?: number;          // server port (default: auto-pick)
  idleTtlMs?: number;     // kill server after this many ms of inactivity (default: 10 min)
}

const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const STARTUP_TIMEOUT_MS = 30_000;           // max wait for server to become ready
const HEALTH_CHECK_INTERVAL_MS = 500;

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function resolveBinary(name: string): Promise<string | null> {
  if (name.startsWith('/')) return (await fileExists(name)) ? name : null;
  try {
    // Augmented PATH: under launchd/systemd the inherited PATH misses Homebrew.
    const { stdout } = await execFileAsync('which', [name], { timeout: 5000, env: sttSpawnEnv() });
    return stdout.trim() || null;
  } catch {
    return null;
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

export function createWhisperServerEngine(cfg: WhisperServerConfig): SttEngine {
  let resolvedBinaryPath: string | null = null;
  let serverProcess: ChildProcess | null = null;
  let serverPort: number | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  // Concurrent transcribe() calls (routine now that a shadow engine can run
  // beside the primary) must share one in-flight start: during startup the
  // port isn't listening yet, and a second caller's health probe would misread
  // that as a dead daemon and kill it.
  let startingPromise: Promise<number> | null = null;
  const idleTtlMs = cfg.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log.stt.info(`whisper-server idle for ${idleTtlMs / 1000}s — shutting down to free memory`);
      killServer();
    }, idleTtlMs);
  }

  /** Kill the daemon. With `only`, no-op unless it is still the CURRENT child —
   *  a stale caller must never take down its successor. */
  function killServer(only?: ChildProcess) {
    if (only && serverProcess !== only) return;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (serverProcess) {
      log.stt.info(`Killing whisper-server (pid=${serverProcess.pid})`);
      serverProcess.kill('SIGTERM');
      // Force kill after 3s if still alive
      const proc = serverProcess;
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
      serverProcess = null;
      serverPort = null;
    }
  }

  /**
   * Wait for the server to respond to health checks.
   * Fails fast if the child exits before becoming ready (e.g. missing ffmpeg
   * kills whisper-server in <1s — no point waiting the full 30s).
   */
  async function waitForReady(proc: ChildProcess, port: number, timeoutMs: number): Promise<'ready' | 'exited' | 'timeout'> {
    const deadline = Date.now() + timeoutMs;
    let exited = false;
    proc.once('exit', () => { exited = true; });
    // spawn failures (ENOENT/EACCES) emit 'error' with NO 'exit' — without this
    // the loop would probe a dead child for the full timeout.
    proc.once('error', () => { exited = true; });
    while (Date.now() < deadline) {
      if (exited) return 'exited';
      try {
        // Per-probe timeout: a port that accepts but never responds must not
        // hang one fetch past the overall deadline.
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
    // A start is already in flight — join it (checked BEFORE the health probe,
    // which would misread a starting-but-not-listening child as dead).
    if (startingPromise) return startingPromise;

    // Already running? Quick health check
    if (serverProcess && serverPort) {
      const probed = serverProcess;
      try {
        const res = await fetch(`http://127.0.0.1:${serverPort}/`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          resetIdleTimer();
          return serverPort;
        }
      } catch {
        // Server died, restart below
        log.stt.warn('whisper-server health check failed — restarting');
        killServer(probed);
      }
    }

    if (!startingPromise) {
      startingPromise = startServer().finally(() => { startingPromise = null; });
    }
    return startingPromise;
  }

  async function startServer(): Promise<number> {
    const bin = resolvedBinaryPath ?? cfg.binaryPath;
    const port = cfg.port ?? await findFreePort();

    const args = [
      '-m', cfg.modelPath,
      '--host', '127.0.0.1',
      '--port', String(port),
      '-l', 'auto',               // auto-detect language (NOT English-only default)
      '--convert',                // let server handle ffmpeg conversion
      '--tmp-dir', tmpdir(),
      '--no-timestamps',
      '--suppress-nst',
      '--no-speech-thold', '0.2',
    ];
    if (cfg.vadModelPath) {
      args.push('--vad', '--vad-model', cfg.vadModelPath);
    }
    if (cfg.prompt) {
      args.push('--prompt', cfg.prompt);
    }

    log.stt.info(`Starting whisper-server: ${bin} ${args.join(' ')}`);

    // Augment PATH with the binary's own prefix + common install dirs: under
    // launchd/systemd the inherited PATH misses Homebrew, and whisper-server's
    // --convert shells out to `ffmpeg` and exits (code 0!) when it's not found.
    const proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: sttSpawnEnv(bin.startsWith('/') ? [dirname(bin)] : []),
    });

    // Log server output for debugging; keep a tail so a startup failure can
    // surface the child's actual complaint instead of a generic timeout.
    const outputTail: string[] = [];
    const captureOutput = (d: Buffer) => {
      const line = d.toString().trim();
      if (!line) return;
      log.stt.debug(`[whisper-server] ${line}`);
      outputTail.push(...line.split('\n'));
      if (outputTail.length > 20) outputTail.splice(0, outputTail.length - 20);
    };
    proc.stdout?.on('data', captureOutput);
    proc.stderr?.on('data', captureOutput);

    proc.on('exit', (code, signal) => {
      log.stt.info(`whisper-server exited (code=${code}, signal=${signal})`);
      if (serverProcess === proc) {
        serverProcess = null;
        serverPort = null;
      }
    });

    proc.on('error', (err) => {
      log.stt.error(`whisper-server spawn error: ${err.message}`);
      if (serverProcess === proc) {
        serverProcess = null;
        serverPort = null;
      }
    });

    serverProcess = proc;
    serverPort = port;

    // Wait for server to be ready
    const outcome = await waitForReady(proc, port, STARTUP_TIMEOUT_MS);
    if (outcome !== 'ready') {
      killServer(proc);
      // Surface the child's own last words — "ffmpeg: command not found" beats
      // a generic timeout. Filter to likely-diagnostic lines (skip GPU init spam).
      const diagnostic = outputTail
        .filter(l => /error|not found|failed|cannot|unable|no such/i.test(l))
        .slice(-3)
        .join('; ');
      const reason = outcome === 'exited'
        ? `whisper-server exited during startup${diagnostic ? `: ${diagnostic}` : ''}`
        : `whisper-server failed to start within ${STARTUP_TIMEOUT_MS / 1000}s${diagnostic ? ` (${diagnostic})` : ''}`;
      log.stt.error(`${reason}${outputTail.length ? ` | tail: ${outputTail.slice(-5).join(' | ')}` : ''}`);
      throw new Error(reason);
    }

    log.stt.info(`whisper-server ready on port ${port} (pid=${proc.pid})`);
    resetIdleTimer();
    return port;
  }

  // Clean up on process exit
  const cleanup = () => killServer();
  process.on('exit', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  return {
    name: 'whisper-server',

    shutdown() {
      killServer();
      process.removeListener('exit', cleanup);
      process.removeListener('SIGTERM', cleanup);
      process.removeListener('SIGINT', cleanup);
    },

    async isAvailable() {
      resolvedBinaryPath = await resolveBinary(cfg.binaryPath);
      if (!resolvedBinaryPath) {
        return { available: false, error: `whisper-server binary not found: ${cfg.binaryPath}` };
      }
      if (!(await fileExists(cfg.modelPath))) {
        return { available: false, error: `Model file not found: ${cfg.modelPath}` };
      }
      if (cfg.vadModelPath && !(await fileExists(cfg.vadModelPath))) {
        return { available: false, error: `VAD model not found: ${cfg.vadModelPath}` };
      }
      // --convert makes whisper-server shell out to ffmpeg at startup and exit
      // (code 0) when missing — catch that here so Settings shows it up front.
      if (!(await isFfmpegAvailable([dirname(resolvedBinaryPath)]))) {
        return { available: false, error: 'ffmpeg not found — install it (e.g. `brew install ffmpeg`) so whisper-server can convert browser audio' };
      }
      return { available: true };
    },

    async transcribe(req: SttRequest): Promise<SttResult> {
      const t0 = Date.now();
      const port = await ensureServerRunning();

      // Build multipart form data directly from base64 — no temp file needed
      const audioBuffer = Buffer.from(req.audio, 'base64');
      const blob = new Blob([audioBuffer], { type: `audio/${req.format}` });

      const form = new FormData();
      form.append('file', blob, `audio.${req.format}`);
      form.append('response_format', 'json');
      if (req.language) {
        form.append('language', req.language);
      }
      // Per-request prompt overrides startup --prompt (vocab from file)
      const effectivePrompt = req.prompt || cfg.prompt;
      if (effectivePrompt) {
        form.append('prompt', effectivePrompt);
      }

      log.stt.info(`Sending ${(audioBuffer.length / 1024).toFixed(1)}KB ${req.format} to whisper-server :${port}`);

      const res = await fetch(`http://127.0.0.1:${port}/inference`, {
        method: 'POST',
        body: form,
      });

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`whisper-server returned ${res.status}: ${errBody}`);
      }

      const json = await res.json() as { text?: string };
      const text = (json.text ?? '').trim();
      return { text, durationMs: Date.now() - t0 };
    },
  };
}
