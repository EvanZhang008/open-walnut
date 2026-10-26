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
 * takeout, and an idle pooled child is reaped after 15 minutes.
 *
 * Where: the pool and the children live in the LOCAL DAEMON (oneshot-core.ts,
 * capability 'oneshot-v1'), like every Claude Code process Walnut starts; this
 * file builds the spawn and reads the stream. A daemon older than that runs
 * the same core in this process (oneshot-client.ts).
 *
 * Tool budgets are the PROMPT's job, not this runner's (user decision
 * 2026-08-30: a mid-run watchdog injection was tried and reverted as
 * over-engineering). The caller's timeoutMs stays the only hard backstop.
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { prewarmOneShot, startOneShot, _resetLocalOneShotForTest, type OneShotHandle } from './oneshot-client.js';

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
  /** The pool gives this child way last: AI search keeps its slot while
   *  plugins with ever-changing prompts come and go. Not part of the key. */
  keepWarm?: boolean;
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

/** The spawn cwd as the CLI sees it. Only used when a child never announced its
 *  own cwd — see the note on WarmRunResult.cwd. */
export function resolvedTmpdir(): string {
  try { return realpathSync(tmpdir()); } catch { return tmpdir(); }
}

function warmDisabled(): boolean {
  return process.env.WALNUT_MICRO_CLAUDE_WARM === '0';
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

/** Env names that decide which account a child signs in with. */
const AUTH_ENV = /^(ANTHROPIC_|AWS_|CLAUDE_CODE_|CLOUD_ML_|GOOGLE_|VERTEX_)/;

/** The whole spawn for a spec, null when there is no CLI. */
function buildSpawn(spec: WarmSpec): { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; warmKey: string } | null {
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
  const cwd = tmpdir();
  const env = buildChildEnv();
  // The pool key is the command line plus the login: a child booted on another
  // argv (another model, prompt, tool set, override) or other credentials never
  // answers this call. The pool lives in the daemon and outlives a server
  // restart, so a rotated token must not reach a child booted on the old one.
  // Not the whole env: the server sets variables of its own at runtime, and a
  // key that moved with them would never find its child.
  const auth = Object.entries(env)
    .filter(([k]) => AUTH_ENV.test(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const warmKey = createHash('sha256').update(JSON.stringify([cli, args, cwd, auth])).digest('hex');
  return { command: cli, args, cwd, env, warmKey };
}

/** Pre-boot one child for the given spec, in the local daemon's pool (or this
 *  process's when the daemon is older). Idempotent: a live pooled child with
 *  the same spec is kept; children of other specs stay beside it, and the
 *  oldest gives way past the pool's size (3). Fire-and-forget (e.g. from a
 *  human-typing signal) — never throws. */
export function prewarmMicroClaude(spec: WarmSpec): void {
  if (warmDisabled()) return;
  try {
    const built = buildSpawn(spec);
    if (built) prewarmOneShot({ ...built, ...(spec.keepWarm ? { warmKeep: true } : {}) });
  } catch (err) {
    log.agent.warn('micro-claude prewarm failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Test hook. */
export function _resetWarmPoolForTesting(): void {
  _resetLocalOneShotForTest();
}

/** A timed-out child: interrupt the turn, close its stdin, SIGTERM a straggler. */
function stopTimedOut(handle: OneShotHandle): void {
  handle.kill('SIGINT');
  handle.kill('end');
  setTimeout(() => handle.kill('SIGTERM'), EXIT_GRACE_MS).unref?.();
}

const EXIT_GRACE_MS = 5_000;

/** One micro-Claude turn on a stream-json child — pooled when available,
 *  cold-spawned otherwise. The run pre-warms a replacement for the NEXT call. */
export async function runWarmMicroClaude(opts: WarmRunOptions): Promise<WarmRunResult> {
  const spec: WarmSpec = {
    system: opts.system, model: opts.model, tools: opts.tools,
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(opts.partial ? { partial: true } : {}),
  };
  const built = buildSpawn(spec);
  if (!built) throw new Error('claude CLI not available');

  const startTime = Date.now();
  let result: ClaudeStreamResult | undefined;
  let toolCalls = 0;
  let stderr = '';
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let handle: OneShotHandle | undefined;
  let started: Promise<OneShotHandle | undefined> = Promise.resolve(undefined);

  const onLine = (line: string, settle: (o: 'result' | 'exit') => void): void => {
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
      // A pooled child printed its init line while it booted; the pool keeps
      // that line and replays it first, so the warm path records it too.
      onInit: (init) => {
        sessionId ??= init.sessionId;
        if (init.cwd) cwd ??= init.cwd;
      },
    });
    if (!parsed) return;
    for (const block of Array.isArray(parsed) ? parsed : [parsed]) {
      try { opts.onBlock?.(block); } catch { /* listeners never break the stream */ }
      if (block.type === 'tool_call' && block.status === 'calling') toolCalls += 1;
    }
  };

  const outcome = await new Promise<'result' | 'exit' | 'timeout'>((resolve) => {
    let settled: 'result' | 'exit' | 'timeout' | null = null;
    const settle = (o: 'result' | 'exit' | 'timeout') => {
      if (settled) return;
      settled = o;
      clearTimeout(timer);
      resolve(o);
    };
    const timer = setTimeout(() => settle('timeout'), opts.timeoutMs);
    started = startOneShot({
      command: built.command,
      args: built.args,
      cwd: built.cwd,
      env: built.env,
      input: JSON.stringify({ type: 'user', message: { role: 'user', content: opts.prompt } }) + '\n',
      // Single-use child: stdin ends at its result line, a straggler is SIGTERMed.
      endOnResult: true,
      ...(warmDisabled() ? {} : { warmKey: built.warmKey, ...(opts.keepWarm ? { warmKeep: true } : {}) }),
      maxMs: opts.timeoutMs + 30_000,
    }, {
      onLine: (line) => onLine(line, settle),
      onStderr: (text) => { if (stderr.length < 10_000) stderr += text; },
      onExit: (exit) => {
        if (exit.error && stderr.length < 10_000) stderr += exit.error;
        settle('exit');
      },
    }).then((h) => {
      handle = h;
      // Timed out while the daemon was still starting it.
      if (settled === 'timeout') stopTimedOut(h);
      return h;
    }, (err: unknown) => {
      if (stderr.length < 10_000) stderr += err instanceof Error ? err.message : String(err);
      settle('exit');
      return undefined;
    });
  });
  // A booted child can answer before its start is acknowledged (the daemon's
  // frames can land in one tick), so read the handle once the run is known.
  if (outcome === 'result') handle ??= await started;

  const durationMs = Date.now() - startTime;
  if (outcome === 'timeout') {
    if (handle) stopTimedOut(handle);
    throw new Error(`micro-claude timed out after ${opts.timeoutMs}ms`);
  }
  if (outcome === 'exit' || !result || result.isError) {
    throw new Error(result?.result
      ?? `claude -p exited before answering${stderr ? ` — ${stderr.slice(0, 500)}` : ''}`);
  }
  log.agent.info('warm micro-claude completed', {
    toolUseId: opts.toolUseId,
    warm: handle?.warm ?? false,
    via: handle?.via,
    durationMs,
    toolCalls,
    costUsd: result.costUsd,
    sessionId,
  });
  return {
    response: result.result,
    costUsd: result.costUsd,
    durationMs,
    warm: handle?.warm ?? false,
    ...(sessionId ? { sessionId } : {}),
    // The child's OWN reported cwd beats what we asked for, and the fallback must
    // be REALPATH'd: os.tmpdir() is `/var/folders/…` on macOS while the CLI
    // resolves and encodes `/private/var/folders/…`, so the un-resolved string
    // names a project directory that no transcript is ever written to (432 of the
    // resolved dirs on this machine against 1 of the other kind).
    cwd: cwd ?? resolvedTmpdir(),
  };
}
