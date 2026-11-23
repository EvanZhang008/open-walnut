/**
 * The lifecycle of a local Python model daemon (the MLX speech recognizer in
 * engine-mlx.ts, the local voice in src/core/tts/engine-qwen.ts): a small
 * stdlib HTTP server on 127.0.0.1 that loads one model and keeps it resident.
 *
 *   - Started on first use, its source fed over stdin (daemon-source.ts).
 *   - On a FIXED port, detached from this server's process group, so the next
 *     Walnut server (we redeploy many times a day) adopts it warm instead of
 *     paying the model load again. Its own idle timer bounds an orphan's life.
 *   - Health-checked before each use; a slow answer is not a dead daemon
 *     (daemon-health.ts), and a busy one is never retired for missing a probe.
 *   - One start in flight at a time: concurrent callers join it, since the
 *     socket binds only after the model loaded and a probe in that window would
 *     misread the starting child as dead.
 *
 * Every daemon must answer GET / with `{ status: "ok", model, rev }` and take
 * POST /shutdown (exit shortly after answering).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { log } from '../../logging/index.js';
import { sttSpawnEnv } from './spawn-env.js';
import { PYTHON_STDIN_SCRIPT, feedDaemonSource } from './daemon-source.js';
import { probeDaemonPatiently, identifyWalnutDaemon, retireDaemon, QUICK_PROBE_MS } from './daemon-health.js';
import { assertVoiceHere } from './voice-here.js';

const HEALTH_CHECK_INTERVAL_MS = 500;

export interface PythonDaemonSpec {
  /** Names it in the log ("mlx daemon"). */
  label: string;
  pythonPath: string;
  model: string;
  /** The fixed port successive servers share. */
  port: number;
  /** The script's revision: a warm daemon running another one is retired, not adopted. */
  rev: string;
  /** The Python source, fed over stdin. */
  source: string;
  /** The arguments after `-`, for the port the daemon will bind. */
  argv: (port: number) => string[];
  /** How long a start (model load, a first-ever download) may take. */
  startupTimeoutMs: number;
  /** The daemon is working on something of ours: a silent probe then means busy, not dead. */
  isBusy?: () => boolean;
  /** A child was spawned: the model load begins (a caller may stop waiting for it). */
  onSpawn?: () => void;
}

export interface PythonDaemon {
  /** The port of a healthy daemon, starting or adopting one when needed. */
  ensure(): Promise<number>;
  /** Retire it (a config change made it stale): a signal to our child, an HTTP shutdown to an adopted one. */
  retire(): void;
  /** The port of the daemon in use, or null when none is. */
  readonly port: number | null;
  /** A start is in flight. */
  readonly starting: boolean;
  /** A spawned child is loading its model (a start past the adopt probe). */
  readonly loading: boolean;
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

export function createPythonDaemon(spec: PythonDaemonSpec): PythonDaemon {
  const { label, model } = spec;
  // serverProcess is null while serving through an ADOPTED daemon (one spawned
  // by a previous walnut server on the shared port): the daemon self-manages
  // its idle TTL, so not holding the process handle is fine.
  let serverProcess: ChildProcess | null = null;
  let serverPort: number | null = null;
  let startingPromise: Promise<number> | null = null;
  let loadingChild: ChildProcess | null = null;

  /**
   * Retire the daemon. When `only` is given, no-op unless it is still the CURRENT
   * child: a stale caller (a failed startup racing a successful restart) must
   * never take down its successor.
   */
  function killServer(only?: ChildProcess) {
    if (only && serverProcess !== only) return;
    if (serverProcess) {
      log.stt.info(`Killing ${label} (pid=${serverProcess.pid})`);
      serverProcess.kill('SIGTERM');
      const proc = serverProcess;
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000).unref();
    } else if (serverPort && !only) {
      log.stt.info(`Shutting down adopted ${label} on :${serverPort}`);
      void fetch(`http://127.0.0.1:${serverPort}/shutdown`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(2000),
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

  async function ensure(): Promise<number> {
    // A start is already in flight: join it. Checked BEFORE the health probe:
    // during startup serverProcess is set but nothing listens yet, and a probe
    // would misread that as a dead daemon and kill it.
    if (startingPromise) return startingPromise;

    const port = serverPort;
    if (port) {
      const probed = serverProcess;
      const health = await probeDaemonPatiently(port, {
        // A daemon mid-generation can hold the GIL long enough to miss the
        // quick probe. Working on our request, or on one we abandoned (the
        // daemon cannot tell), it is BUSY, not dead: killing it would abort the
        // work. Queue behind it.
        isBusy: spec.isBusy,
        // Silent with nothing of ours running: another server's request, or
        // our own event loop running late. Look again, patiently.
        onSlow: () => log.stt.info(`${label} slow to answer its health probe (>${QUICK_PROBE_MS}ms): looking again before restarting`),
      });
      if (health === 'busy') {
        log.stt.info(`${label} busy (health probe timed out while it is generating): queuing`);
        return port;
      }
      if (health === 'ok') return port;
      // Someone else began (or finished) a restart while we were probing.
      if (startingPromise) return startingPromise;
      if (serverPort !== port) return ensure();
      log.stt.warn(`${label} health check failed (${health}): restarting`);
      serverProcess = null;
      serverPort = null;
      startingPromise = retireDaemon(probed, port, label)
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
    let port = spec.port;

    // A previous walnut server may have left a warm daemon on the shared port.
    // Adopting it skips the model load. A daemon for a different model, or one
    // running an older script (its rev differs), is retired first; a non-walnut
    // listener means the port is simply taken, so fall back to an exclusive one.
    const found = await identifyWalnutDaemon(port, model, spec.rev);
    if (found === 'ours') {
      serverProcess = null;
      serverPort = port;
      log.stt.info(`Adopted existing ${label} on :${port} (model=${model})`);
      return port;
    }
    if (found === 'other-model') {
      await retireDaemon(null, port, `${label} for a different model or script`);
    } else if (found === 'foreign') {
      log.stt.warn(`Port ${port} is held by a process that is not a working walnut ${label}: using an ephemeral port`);
      port = await findFreePort();
    }
    log.stt.info(`Starting ${label}: ${spec.pythonPath} - ${model} :${port} (source over stdin)`);
    // detached: the server often runs as a launchd job, and launchd kills the
    // job's whole process group on `launchctl remove` (every redeploy). A
    // daemon in its own group survives that, which is the point of adoption.
    const proc = spawn(spec.pythonPath, [PYTHON_STDIN_SCRIPT, ...spec.argv(port)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: sttSpawnEnv(),
    });
    feedDaemonSource(proc, spec.source);

    const outputTail: string[] = [];
    const captureOutput = (d: Buffer) => {
      const line = d.toString().trim();
      if (!line) return;
      log.stt.debug(`[${label}] ${line}`);
      outputTail.push(...line.split('\n'));
      if (outputTail.length > 20) outputTail.splice(0, outputTail.length - 20);
    };
    proc.stdout?.on('data', captureOutput);
    proc.stderr?.on('data', captureOutput);

    proc.on('exit', (code, signal) => {
      log.stt.info(`${label} exited (code=${code}, signal=${signal})`);
      if (serverProcess === proc) {
        serverProcess = null;
        serverPort = null;
      }
    });
    proc.on('error', (err) => {
      log.stt.error(`${label} spawn error: ${err.message}`);
      if (serverProcess === proc) {
        serverProcess = null;
        serverPort = null;
      }
    });

    serverProcess = proc;
    serverPort = port;
    loadingChild = proc;
    spec.onSpawn?.();

    let outcome: Awaited<ReturnType<typeof waitForReady>>;
    try {
      outcome = await waitForReady(proc, port, spec.startupTimeoutMs);
    } finally {
      if (loadingChild === proc) loadingChild = null;
    }
    if (outcome === 'exited' && (await identifyWalnutDaemon(port, model, spec.rev)) === 'ours') {
      // Two walnut servers raced a cold start on the shared port; the other one
      // won the bind and its daemon is healthy: adopt instead of failing.
      serverProcess = null;
      serverPort = port;
      log.stt.info(`Lost the ${label} bind race: adopted the winner on :${port}`);
      return port;
    }
    if (outcome !== 'ready') {
      killServer(proc);
      const diagnostic = outputTail
        .filter(l => /error|not found|failed|cannot|unable|no such|traceback/i.test(l))
        .slice(-3)
        .join('; ');
      const reason = outcome === 'exited'
        ? `${label} exited during startup${diagnostic ? `: ${diagnostic}` : ''}`
        : `${label} failed to start within ${spec.startupTimeoutMs / 1000}s${diagnostic ? ` (${diagnostic})` : ''}`;
      log.stt.error(`${reason}${outputTail.length ? ` | tail: ${outputTail.slice(-5).join(' | ')}` : ''}`);
      throw new Error(reason);
    }

    log.stt.info(`${label} ready on port ${port} (pid=${proc.pid}, model=${model})`);
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
    ensure,
    retire: () => killServer(),
    get port() { return serverPort; },
    get starting() { return startingPromise !== null; },
    get loading() { return loadingChild !== null; },
  };
}
