/**
 * Warm micro-Claude — pre-booted `claude -p --input-format stream-json`
 * children for the minimum-Claude pattern (micro-claude.ts).
 *
 * Why: CLI boot is ~2-2.5s of every micro-Claude call (POC 2026-08-30:
 * cold send→result 4.6s, pre-booted child 2.0s). A plain `-p` child can't
 * be pre-spawned (empty stdin makes it exit within ~5s), but a stream-json
 * child waits for input indefinitely — the same long-running shape the
 * session daemon runs on. So we keep ONE pre-booted child per spec (model +
 * system + tools) and hand it the prompt the moment a call arrives. Several
 * specs can be warm at once (AI search, each plugin's `ai.run` prompt), up to
 * POOL_MAX; the least recently warmed one gives way.
 *
 * Lifecycle: take the pooled child (or cold-spawn the same shape), write
 * one user message, resolve on the CLI's `result` line, then end stdin so
 * the child exits — children are SINGLE-USE (a second turn would carry the
 * first query's context). A replacement is pre-spawned immediately after
 * takeout, and an idle pooled child is reaped after POOL_IDLE_TTL_MS.
 *
 * Tool budgets are the PROMPT's job, not this runner's (user decision
 * 2026-08-30: a mid-run watchdog injection was tried and reverted as
 * over-engineering). The caller's timeoutMs stays the only hard backstop.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface, type Interface } from 'node:readline';
import { log } from '../logging/index.js';
import { resolveClaudeCliExecutable } from '../core/claude-cli-detect.js';
import {
  readUserSettingsEnv,
  slimChildSettingsArg,
  WALNUT_UTILITY_ENTRYPOINT,
} from './inline-subagent.js';
import {
  parseClaudeJsonlLine,
  type ClaudeStreamResult,
  type StreamingBlock,
} from './claude-stream-parser.js';

export interface WarmSpec {
  /** REPLACES the CLI system prompt (slim child). */
  system: string;
  model: string;
  /** CLI tool names to keep; [] = none. */
  tools: string[];
  /** --effort level; undefined = the CLI's own default for the model. */
  effort?: string;
  /** Stream text as it is written (`--include-partial-messages`), for `onTextDelta`. */
  partial?: boolean;
}

export interface WarmRunOptions extends WarmSpec {
  prompt: string;
  timeoutMs: number;
  toolUseId: string;
  onBlock?: (block: StreamingBlock) => void;
  /** Each piece of answer text as the model writes it. Needs `partial`. */
  onTextDelta?: (text: string) => void;
}

export interface WarmRunResult {
  response: string;
  costUsd?: number;
  durationMs: number;
  /** True when the answer came from a pre-booted child (telemetry). */
  warm: boolean;
  /**
   * The child's OWN claude session id, and the cwd it ran in.
   *
   * A micro-Claude child is a real Claude Code session: it writes a transcript
   * under ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl and `--resume
   * <sessionId>` from that same cwd continues it (verified 2026-09-16, same id
   * back). That makes the run ADOPTABLE — a caller can hand the finished
   * conversation to the user instead of asking a second agent to redo the work
   * (first consumer: the ✦ AI search card's "Open as session").
   */
  sessionId?: string;
  cwd?: string;
}

const POOL_IDLE_TTL_MS = 15 * 60_000;
/** Warm children kept at once, one per spec. Each is an idle CLI process. */
const POOL_MAX = 3;
const EXIT_GRACE_MS = 5_000;

interface PooledChild {
  proc: ChildProcess;
  rl: Interface;
  key: string;
  spawnedAt: number;
  /** Captured from the child's own `system:init` line — see WarmRunResult. */
  sessionId?: string;
  cwd?: string;
}

/** Warm children by spec key, oldest first (Map keeps insertion order). */
const pool = new Map<string, PooledChild>();
const reapTimers = new Map<string, ReturnType<typeof setTimeout>>();

function specKey(spec: WarmSpec): string {
  return createHash('sha256')
    .update(`${spec.model}|${spec.effort ?? ''}|${spec.tools.join(',')}|${spec.partial ? 'partial' : ''}|${spec.system}`)
    .digest('hex');
}

function alive(child: PooledChild): boolean {
  return child.proc.exitCode === null && !child.proc.killed;
}

function warmDisabled(): boolean {
  return process.env.WALNUT_MICRO_CLAUDE_WARM === '0';
}

/** The spawn cwd as the CLI sees it. Only used when a child never announced its
 *  own cwd — see the note on WarmRunResult.cwd. */
export function resolvedTmpdir(): string {
  try { return realpathSync(tmpdir()); } catch { return tmpdir(); }
}

function buildChildEnv(): NodeJS.ProcessEnv {
  // Same env contract as inline-subagent's slim children: no nested-session
  // detection, settings.json env re-applied (Bedrock auth lives there),
  // import-scan marker, thinking off (utility children answer contracts).
  const { CLAUDECODE: _drop, ...env } = process.env;
  Object.assign(env, readUserSettingsEnv());
  env.CLAUDE_CODE_ENTRYPOINT = WALNUT_UTILITY_ENTRYPOINT;
  env.MAX_THINKING_TOKENS = '0';
  return env;
}

function spawnStreamChild(spec: WarmSpec): PooledChild | null {
  const cli = resolveClaudeCliExecutable();
  if (!cli) return null;
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    ...(spec.partial ? ['--include-partial-messages'] : []),
    '--model', spec.model,
    '--allow-dangerously-skip-permissions',
    '--permission-mode', 'bypassPermissions',
    '--system-prompt', spec.system,
    '--tools', spec.tools.join(','),
    '--setting-sources', '',
    '--bare',
  ];
  if (spec.effort) args.push('--effort', spec.effort);
  // The user's modelOverrides, so the alias resolves as their CLI resolves it.
  const settings = slimChildSettingsArg();
  if (settings) args.push('--settings', settings);
  const proc = spawn(cli, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: tmpdir(),
    env: buildChildEnv(),
  });
  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  const child: PooledChild = { proc, rl, key: specKey(spec), spawnedAt: Date.now() };
  // Capture the session id HERE, not in runWarmMicroClaude: a pooled child
  // prints its `system:init` line while it boots, long before a call takes it
  // out and attaches its own line listener — readline drops what nobody was
  // listening for, so a run-time-only capture misses it on exactly the warm
  // path that is the point of this pool. Parsing stops after the first init.
  rl.on('line', (line) => {
    if (child.sessionId) return;
    if (!line.includes('"init"')) return;
    parseClaudeJsonlLine(line, {
      onInit: (init) => {
        child.sessionId = init.sessionId;
        if (init.cwd) child.cwd = init.cwd;
      },
    });
  });
  return child;
}

function disposePooled(key: string): void {
  const child = pool.get(key);
  const timer = reapTimers.get(key);
  if (timer) clearTimeout(timer);
  reapTimers.delete(key);
  if (!child) return;
  pool.delete(key);
  try { child.proc.kill('SIGTERM'); } catch { /* already gone */ }
}

function disposeAll(): void {
  for (const key of [...pool.keys()]) disposePooled(key);
}

/** Pre-boot one child for the given spec. Idempotent: a live pooled child
 *  with the same spec is kept; children of other specs stay beside it, and
 *  the oldest gives way past POOL_MAX. Fire-and-forget
 *  (e.g. from a human-typing signal) — never throws. */
export function prewarmMicroClaude(spec: WarmSpec): void {
  if (warmDisabled()) return;
  try {
    const key = specKey(spec);
    const existing = pool.get(key);
    if (existing && alive(existing)) return;
    disposePooled(key);
    while (pool.size >= POOL_MAX) disposePooled(pool.keys().next().value as string);
    const child = spawnStreamChild(spec);
    if (!child) return;
    child.proc.on('exit', () => {
      if (pool.get(key)?.proc === child.proc) {
        pool.delete(key);
        const timer = reapTimers.get(key);
        if (timer) clearTimeout(timer);
        reapTimers.delete(key);
      }
    });
    pool.set(key, child);
    const timer = setTimeout(() => { disposePooled(key); }, POOL_IDLE_TTL_MS);
    timer.unref?.();
    reapTimers.set(key, timer);
  } catch (err) {
    log.agent.warn('micro-claude prewarm failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Test hook. */
export function _resetWarmPoolForTesting(): void {
  disposeAll();
}

process.once('exit', () => { disposeAll(); });

/** One micro-Claude turn on a stream-json child — pooled when available,
 *  cold-spawned otherwise. Always pre-warms a replacement for the NEXT call. */
export async function runWarmMicroClaude(opts: WarmRunOptions): Promise<WarmRunResult> {
  const spec: WarmSpec = {
    system: opts.system, model: opts.model, tools: opts.tools,
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(opts.partial ? { partial: true } : {}),
  };
  const key = specKey(spec);
  let taken: PooledChild | null = null;
  let warm = false;
  const pooledChild = pool.get(key);
  if (!warmDisabled() && pooledChild && alive(pooledChild)) {
    taken = pooledChild;
    pool.delete(key);
    const timer = reapTimers.get(key);
    if (timer) clearTimeout(timer);
    reapTimers.delete(key);
    warm = true;
  } else {
    taken = spawnStreamChild(spec);
  }
  if (!taken) throw new Error('claude CLI not available');
  // Replace the pool slot immediately so the NEXT call is warm too.
  prewarmMicroClaude(spec);

  // `const` so the callbacks below keep the narrowing (a `let` loses it inside
  // a closure) — they record the child's session id for adoptable runs.
  const child = taken;
  const { proc, rl } = child;
  const startTime = Date.now();
  let result: ClaudeStreamResult | undefined;
  let toolCalls = 0;
  let stderr = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 10_000) stderr += chunk.toString();
  });

  const outcome = await new Promise<'result' | 'exit' | 'timeout'>((resolve) => {
    let settled = false;
    const settle = (o: 'result' | 'exit' | 'timeout') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(o);
    };
    const timer = setTimeout(() => settle('timeout'), opts.timeoutMs);

    rl.on('line', (line) => {
      // Partial text is read here and kept from onBlock: the parser gives a delta and the
      // finished message the same block shape, so onBlock keeps seeing finished blocks only.
      if (spec.partial && line.includes('"stream_event"')) {
        type PartialLine = { type?: string; event?: { type?: string; delta?: { type?: string; text?: string } } };
        let event: PartialLine | null = null;
        try { event = JSON.parse(line) as PartialLine; } catch { /* not JSON: the parser below decides */ }
        if (event?.type === 'stream_event') {
          const inner = event.event;
          if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && inner.delta.text) {
            try { opts.onTextDelta?.(inner.delta.text); } catch { /* listeners never break the stream */ }
          }
          return;
        }
      }
      const parsed = parseClaudeJsonlLine(line, {
        onResult: (r) => { result = r; settle('result'); },
        // Cold-spawned children (pool miss) init after this listener exists;
        // for a pooled child spawnStreamChild already recorded it.
        onInit: (init) => {
          child.sessionId ??= init.sessionId;
          if (init.cwd) child.cwd ??= init.cwd;
        },
      });
      if (!parsed) return;
      for (const block of Array.isArray(parsed) ? parsed : [parsed]) {
        try { opts.onBlock?.(block); } catch { /* listeners never break the stream */ }
        if (block.type === 'tool_call' && block.status === 'calling') toolCalls += 1;
      }
    });
    proc.on('exit', () => settle('exit'));
    proc.on('error', () => settle('exit'));

    try {
      proc.stdin?.write(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: opts.prompt },
      }) + '\n');
    } catch { settle('exit'); } // pooled child died between checks
  });

  // Single-use child: end stdin so it exits on its own; force-kill stragglers.
  try { proc.stdin?.end(); } catch { /* already closed */ }
  const grace = setTimeout(() => {
    if (proc.exitCode === null) { try { proc.kill('SIGTERM'); } catch { /* gone */ } }
  }, EXIT_GRACE_MS);
  grace.unref?.();

  const durationMs = Date.now() - startTime;
  if (outcome === 'timeout') {
    try { proc.kill('SIGINT'); } catch { /* gone */ }
    throw new Error(`micro-claude timed out after ${opts.timeoutMs}ms`);
  }
  if (outcome === 'exit' || !result || result.isError) {
    throw new Error(result?.result
      ?? `claude -p exited before answering${stderr ? ` — ${stderr.slice(0, 500)}` : ''}`);
  }
  log.agent.info('warm micro-claude completed', {
    toolUseId: opts.toolUseId,
    warm,
    durationMs,
    toolCalls,
    costUsd: result.costUsd,
    sessionId: child.sessionId,
  });
  return {
    response: result.result,
    costUsd: result.costUsd,
    durationMs,
    warm,
    ...(child.sessionId ? { sessionId: child.sessionId } : {}),
    // The child's OWN reported cwd beats what we asked for, and the fallback must
    // be REALPATH'd: os.tmpdir() is `/var/folders/…` on macOS while the CLI
    // resolves and encodes `/private/var/folders/…`, so the un-resolved string
    // names a project directory that no transcript is ever written to (432 of the
    // resolved dirs on this machine against 1 of the other kind).
    cwd: child.cwd ?? resolvedTmpdir(),
  };
}
