/**
 * MLX STT engine (Apple Silicon).
 *
 * Runs an mlx-audio ASR model (default: Qwen3-ASR) as a persistent local HTTP
 * daemon, so the model loads once and stays resident on the GPU — repeat
 * dictations skip the ~5s Python/model cold start. Mirrors the whisper-server
 * engine's lifecycle exactly: auto-start on first transcription, health-checked
 * reuse, idle TTL, shutdown() kill, singleton via getOrCreateEngine.
 *
 * The daemon is a small stdlib-only Python script (mlx-daemon-script.ts, fed to
 * the interpreter over stdin at spawn, see daemon-source.ts). It needs a Python env
 * with `mlx-audio` installed —
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
import { stat } from 'node:fs/promises';
import { log } from '../../logging/index.js';
import { sttSpawnEnv } from './spawn-env.js';
import { PYTHON_STDIN_SCRIPT, feedDaemonSource } from './daemon-source.js';
import { MLX_SERVER_PY, MLX_DAEMON_REV } from './mlx-daemon-script.js';
import { convertToWav, cleanupTempFile } from './audio-convert.js';
import {
  probeDaemonPatiently, identifyWalnutDaemon, retireDaemon, isDaemonConnectionLost, QUICK_PROBE_MS,
} from './daemon-health.js';
import { assertVoiceHere, voiceOffHere } from './voice-here.js';
import type { SttEngine, SttRequest, SttResult } from './types.js';

const execFileAsync = promisify(execFile);

export interface MlxEngineConfig {
  pythonPath: string;   // python interpreter with mlx-audio installed
  model?: string;       // HF model id or local path (default: Qwen3-ASR 8-bit)
  port?: number;        // daemon port (default: auto-pick)
  idleTtlMs?: number;   // kill daemon after inactivity (default: 10 min)
  importProbeTimeoutMs?: number; // `import mlx_audio` check (default: 30s; tests shorten it)
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
  // A request we stopped waiting for (a dropped live draft) keeps the daemon
  // generating: it cannot see the closed socket. Until its own deadline the
  // daemon counts as busy, so a missed probe never retires it mid-orphan.
  let abandonedBusyUntil = 0;
  // Import check is ~1s of Python startup — cache SUCCESS only, so isAvailable()
  // stays cheap once probed but `pip install mlx-audio` is picked up without a
  // walnut restart after a failed probe.
  let mlxImportOk = false;
  // The daemon says in every reply whether its loop guard ran (mlx-daemon-script.ts).
  let loopGuardOffWarned = false;
  function noteLoopGuard(reply: { loopGuard?: number | null; loopGuardOff?: string }) {
    if (reply.loopGuard) {
      log.stt.info(`Loop guard fired on ${reply.loopGuard} decoding step(s): a degenerate repetition was stopped`);
    } else if (reply.loopGuard !== 0 && !loopGuardOffWarned) {
      loopGuardOffWarned = true;
      log.stt.warn(`mlx daemon runs without its loop guard${reply.loopGuardOff ? `: ${reply.loopGuardOff}` : ''}`);
    }
  }

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
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000).unref();
    } else if (serverPort && !only) {
      log.stt.info(`Shutting down adopted mlx daemon on :${serverPort}`);
      void fetch(`http://127.0.0.1:${serverPort}/shutdown`, {
        method: 'POST', signal: AbortSignal.timeout(2000),
      }).catch(() => {});
    }
    serverProcess = null;
    serverPort = null;
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

    const port = serverPort;
    if (port) {
      const probed = serverProcess;
      const health = await probeDaemonPatiently(port, {
        // A daemon mid-generation can hold the GIL long enough to miss the
        // quick probe. Working on our request, or on one we abandoned (the
        // daemon cannot tell), it is BUSY, not dead: killing it would abort a
        // transcription. Queue behind it.
        isBusy: () => inFlight > 0 || Date.now() < abandonedBusyUntil,
        // Silent with nothing of ours running: another server's request, or
        // our own event loop running late. Look again, patiently.
        onSlow: () => log.stt.info(`mlx daemon slow to answer its health probe (>${QUICK_PROBE_MS}ms) — looking again before restarting`),
      });
      if (health === 'busy') {
        log.stt.info('mlx daemon busy (health probe timed out while it is generating) — queuing');
        return port;
      }
      if (health === 'ok') return port;
      // Someone else began (or finished) a restart while we were probing.
      if (startingPromise) return startingPromise;
      if (serverPort !== port) return ensureServerRunning();
      log.stt.warn(`mlx daemon health check failed (${health}) — restarting`);
      serverProcess = null;
      serverPort = null;
      startingPromise = retireDaemon(probed, port, 'mlx daemon')
        .then(startServer)
        .finally(() => { startingPromise = null; });
      return startingPromise;
    }

    startingPromise ??= startServer().finally(() => { startingPromise = null; });
    return startingPromise;
  }

  async function startServer(): Promise<number> {
    // Before the adopt probe too: an isolated server must not take over the warm
    // daemon the user's own server keeps on the shared port (voice-here.ts).
    assertVoiceHere();
    let port = cfg.port ?? DEFAULT_MLX_PORT;

    // A previous walnut server (we redeploy many times a day) may have left a
    // warm daemon on the shared port. Adopting it skips the ~2 GB model load —
    // THE fix for dictation stalling after every deploy. A daemon for a
    // different model, or one running an older script (its rev differs), is
    // retired first; a non-walnut listener means the port is simply taken, so
    // fall back to an exclusive one.
    const found = await identifyWalnutDaemon(port, model, MLX_DAEMON_REV);
    if (found === 'ours') {
      serverProcess = null;
      serverPort = port;
      log.stt.info(`Adopted existing mlx daemon on :${port} (model=${model})`);
      return port;
    }
    if (found === 'other-model') {
      await retireDaemon(null, port, 'mlx daemon for a different model or script');
    } else if (found === 'foreign') {
      log.stt.warn(`Port ${port} is held by a process that is not a working walnut mlx daemon — using an ephemeral port`);
      port = await findFreePort();
    }
    log.stt.info(`Starting mlx daemon: ${cfg.pythonPath} - ${model} :${port} (source over stdin)`);
    // detached: the server often runs as a launchd job, and launchd kills the
    // job's whole process group on `launchctl remove` (every redeploy). A
    // daemon in its own group survives that, which is the point of adoption.
    const proc = spawn(cfg.pythonPath, [PYTHON_STDIN_SCRIPT, model, String(port), String(idleTtlMs / 1000), MLX_DAEMON_REV], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: sttSpawnEnv(),
    });
    feedDaemonSource(proc, MLX_SERVER_PY);

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
    if (outcome === 'exited' && (await identifyWalnutDaemon(port, model, MLX_DAEMON_REV)) === 'ours') {
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
    model,

    async warmup() {
      await ensureServerRunning();
    },

    shutdown() {
      // Config changed (model/TTL/port) — the daemon really is stale, retire it.
      killServer();
    },

    async isAvailable() {
      const off = voiceOffHere();
      if (off) return { available: false, error: off };
      if (!(await fileExists(cfg.pythonPath))) {
        return { available: false, error: `Python interpreter not found: ${cfg.pythonPath}` };
      }
      // A daemon that finished starting (or was adopted) imported mlx_audio: no
      // probe needed. Not while one is still starting: it may yet die on the import.
      if (serverPort !== null && !startingPromise) mlxImportOk = true;
      if (!mlxImportOk) {
        try {
          await execFileAsync(cfg.pythonPath, ['-c', 'import mlx_audio'], { timeout: cfg.importProbeTimeoutMs ?? 30_000, env: sttSpawnEnv() });
          mlxImportOk = true;
        } catch (err) {
          // A probe the clock killed proves nothing about the install: at load
          // 400 a Python start can outlast it, and "not installed" would grey the
          // mic out for a minute. Say available; a real missing module still
          // fails the daemon start with its own error.
          if ((err as { killed?: boolean }).killed) {
            log.stt.warn(`mlx-audio import check timed out in ${cfg.pythonPath} (machine busy?) — not treating it as missing`);
            return { available: true };
          }
          return { available: false, error: `mlx-audio not installed in ${cfg.pythonPath} (pip install mlx-audio)` };
        }
      }
      // No ffmpeg check: WAV and the phone's CAF convert in-process, and any
      // other format names ffmpeg in its own error (convertToWav).
      return { available: true };
    },

    async transcribe(req: SttRequest): Promise<SttResult> {
      const t0 = Date.now();
      const port = await ensureServerRunning();
      // A live draft the browser already dropped must not take a turn on the
      // model: the daemon serves one generate at a time, so every orphan runs
      // ahead of the request the user is actually waiting for.
      req.signal?.throwIfAborted();
      const wavPath = await convertToWav(req.audio, req.format);
      inFlight++; // after convertToWav — a convert throw must not leak the counter
      try {
        // Timeout scales with audio length (16kHz mono s16le = 32000 bytes/s):
        // transcription runs ~15x realtime on Metal, so 8x realtime + 90s floor
        // is generous headroom without letting a dictation hang for 15 minutes.
        const wavBytes = (await stat(wavPath)).size;
        const timeoutMs = Math.round(Math.min(15 * 60_000, Math.max(90_000, (wavBytes / 32_000) * 8_000)));
        let dispatched = false;
        const post = async (daemonPort: number): Promise<SttResult> => {
          req.signal?.throwIfAborted();
          dispatched = true;
          log.stt.info(`Sending ${wavPath} to mlx daemon :${daemonPort} (model=${model}, timeout=${Math.round(timeoutMs / 1000)}s)`);
          const timeout = AbortSignal.timeout(timeoutMs);
          const res = await fetch(`http://127.0.0.1:${daemonPort}/inference`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              wav: wavPath,
              language: mlxLanguageName(req.language),
              system_prompt: req.prompt || undefined,
            }),
            signal: req.signal ? AbortSignal.any([timeout, req.signal]) : timeout,
          });
          if (!res.ok) {
            let detail = '';
            try { detail = ((await res.json()) as { error?: string }).error ?? ''; } catch {}
            throw new Error(`mlx daemon returned ${res.status}${detail ? `: ${detail}` : ''}`);
          }
          const json = await res.json() as { text?: string; loopGuard?: number | null; loopGuardOff?: string };
          noteLoopGuard(json);
          return { text: (json.text ?? '').trim(), durationMs: Date.now() - t0 };
        };
        try {
          return await post(port);
        } catch (err) {
          if (req.signal?.aborted) {
            if (!dispatched) throw err;
            // Dropped mid-generate: the daemon keeps going for about as long
            // as the audio lasts (realtime is the pessimistic end), plus slack.
            abandonedBusyUntil = Math.max(abandonedBusyUntil, Date.now() + Math.min(timeoutMs, (wavBytes / 32_000) * 1000 + 30_000));
            throw err;
          }
          // The daemon went away under this request (crashed, hit its idle
          // TTL, or another server retired it). Transcribing is idempotent, so
          // bring it back and ask once more instead of failing the dictation.
          if (!isDaemonConnectionLost(err)) throw err;
          log.stt.warn(`mlx daemon connection lost mid-request (${err instanceof Error ? err.message : String(err)}) — retrying once`);
          try {
            // Not in flight while checking: this request is exactly the one
            // that proved the daemon gone, so it must not make a daemon still
            // on its way out look "busy" to its own health check.
            inFlight--;
            let nextPort: number;
            try { nextPort = await ensureServerRunning(); } finally { inFlight++; }
            return await post(nextPort);
          } catch (retryErr) {
            if (!isDaemonConnectionLost(retryErr)) throw retryErr;
            throw new Error('mlx daemon connection lost twice in a row', { cause: retryErr });
          }
        }
      } finally {
        inFlight--;
        await cleanupTempFile(wavPath);
      }
    },
  };
}
