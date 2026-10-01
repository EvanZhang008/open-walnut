/**
 * Live event streaming for STT setup steps.
 *
 * Every setup action (brew install, Python env, model download) is an async
 * generator of SetupEvents that the route forwards as SSE. The events a child
 * process produces arrive in callbacks (stdout lines, timers), so they are pushed
 * into a queue that the generator drains AS THEY HAPPEN. The old brew helper
 * collected its periodic progress in an array and yielded it only after brew
 * exited, so the bar sat at 5% for the whole install.
 */

import { spawn } from 'node:child_process';
import { log } from '../../logging/index.js';

export interface SetupEvent {
  type: 'progress' | 'log' | 'done' | 'error';
  message?: string;
  /** 0-100 for downloads; omitted when the total is unknown. */
  percent?: number;
  /** For done events */
  path?: string;
}

/** Push-based async queue: callbacks push, one generator drains live. */
export function eventQueue<T>() {
  const items: T[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const notify = () => { const w = wake; wake = null; w?.(); };
  return {
    push(v: T) { if (closed) return; items.push(v); notify(); },
    close() { closed = true; notify(); },
    async *drain(): AsyncGenerator<T> {
      for (;;) {
        while (items.length) yield items.shift() as T;
        if (closed) return;
        await new Promise<void>((r) => { wake = r; });
      }
    },
  };
}

export interface StreamRunOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Server log prefix, e.g. `brew` or `uv`. */
  label: string;
  signal?: AbortSignal;
  /** Forward each output line as a `log` event (default true). */
  logLines?: boolean;
  /**
   * Sees every output line first. Return true to consume it: a machine-readable
   * line (a progress counter) is then neither logged, forwarded, nor the "last line".
   */
  onLine?: (line: string) => boolean;
  /** Called every tickMs with the latest output line; a returned event is streamed. */
  onTick?: (lastLine: string) => SetupEvent | null | Promise<SetupEvent | null>;
  tickMs?: number;
}

export interface StreamRunResult {
  code: number;
  lastLine: string;
  timedOut: boolean;
  aborted: boolean;
}

/**
 * Run a command, streaming its output lines and tick events live. Returns the
 * exit code and the last non-empty output line (the usual error explanation).
 * The child is stopped when the signal aborts, the timeout passes, or the
 * consumer stops iterating early.
 */
export async function* runStreaming(
  cmd: string,
  args: string[],
  opts: StreamRunOptions,
): AsyncGenerator<SetupEvent, StreamRunResult> {
  const q = eventQueue<SetupEvent>();
  let lastLine = '';
  let code: number | null = null;
  let timedOut = false;
  let aborted = false;

  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: opts.env });

  const emitLine = (raw: string) => {
    const line = raw.trim();
    if (!line) return;
    if (opts.onLine?.(line)) return;
    lastLine = line.slice(0, 300);
    log.stt.info(`[${opts.label}] ${lastLine}`);
    if (opts.logLines !== false) q.push({ type: 'log', message: lastLine });
  };
  const sinkLines = (stream: NodeJS.ReadableStream | null) => {
    if (!stream) return;
    let partial = '';
    stream.on('data', (chunk: Buffer) => {
      const parts = (partial + chunk.toString()).split(/\r\n|\n|\r/);
      partial = parts.pop() ?? '';
      // Progress-bar tools redraw one line with \r; very long partials are noise.
      if (partial.length > 4000) partial = '';
      parts.forEach(emitLine);
    });
    // The last line often has no newline (an error message right before exit).
    stream.on('end', () => { emitLine(partial); partial = ''; });
  };
  sinkLines(child.stdout);
  sinkLines(child.stderr);

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (code !== null) return;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    killTimer ??= setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 5_000);
    killTimer.unref?.();
  };
  const onAbort = () => { aborted = true; stop(); };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener('abort', onAbort, { once: true });

  const deadline = setTimeout(() => { timedOut = true; stop(); }, opts.timeoutMs);
  let ticking = false;
  const tick = opts.onTick
    ? setInterval(() => {
        if (ticking) return;
        ticking = true;
        Promise.resolve(opts.onTick!(lastLine))
          .then((e) => { if (e) q.push(e); })
          .catch(() => { /* a failed tick is skipped, never fatal */ })
          .finally(() => { ticking = false; });
      }, opts.tickMs ?? 3000)
    : undefined;

  const finish = (c: number) => {
    if (code !== null) return;
    code = c;
    q.close();
  };
  child.on('close', (c) => finish(c ?? 1));
  child.on('error', (err) => { lastLine = err.message; finish(1); });

  try {
    yield* q.drain();
  } finally {
    clearTimeout(deadline);
    if (tick) clearInterval(tick);
    opts.signal?.removeEventListener('abort', onAbort);
    // The consumer left early (the client went away): do not leave it running.
    if (code === null) stop();
  }
  if (killTimer) clearTimeout(killTimer);
  return { code: code ?? 1, lastLine, timedOut, aborted };
}

/** Synthetic progress for tools that report none: creeps toward `ceiling`. */
export function creepingProgress(start: number, step: number, ceiling: number, fallback: string) {
  let percent = start;
  return (lastLine: string): SetupEvent => {
    if (percent < ceiling) percent = Math.min(ceiling, percent + step);
    return { type: 'progress', percent, message: lastLine || fallback };
  };
}
