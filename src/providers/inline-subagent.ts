/**
 * Inline Subagent — lightweight Claude Code subprocess runner.
 *
 * Runs `claude -p --output-format stream-json` and streams JSONL output
 * as StreamingBlock events via the event bus. The child is the local daemon's
 * (oneshot-client.ts), like every Claude Code process Walnut starts. Used by the `create_subagent`
 * tool to give the main agent quick AI-assisted tasks without creating
 * a full session.
 *
 * Features:
 * - Synchronous (foreground) and async (background) modes
 * - Concurrent limit via semaphore (max 3)
 * - Two-phase kill on timeout: SIGINT → 3s → SIGTERM
 * - Clean env (strips CLAUDECODE to avoid nested session detection)
 *
 * Permission mode is always bypassPermissions — subagents are trusted
 * internal tools spawned by the main agent, not user-facing sessions.
 */

import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { bus, EventNames } from '../core/event-bus.js';
import { log } from '../logging/index.js';
import { resolveClaudeCliExecutable } from '../core/claude-cli-detect.js';
import { claudeFallbackCommand } from '../core/test-claude-guard.js';
import {
  parseClaudeJsonlLine,
  accumulateBlock,
  type StreamingBlock,
  type ClaudeStreamInit,
  type ClaudeStreamResult,
} from './claude-stream-parser.js';
import { startOneShot, type OneShotExit, type OneShotHandle } from './oneshot-client.js';

// ── Types ──

/** CLAUDE_CODE_ENTRYPOINT for every Walnut-spawned utility child. The CLI
 *  records it verbatim in the transcript head (it never overwrites a preset
 *  value), and the external-session import scan only accepts the entrypoints
 *  on its allowlists (cli/claude-desktop/sdk-cli/sdk-ts) — so children marked
 *  with this value can NEVER surface as import candidates, regardless of cwd.
 *  Verified live 2026-08-28: transcript records "entrypoint":"walnut-utility",
 *  child behavior unchanged. */
export const WALNUT_UTILITY_ENTRYPOINT = 'walnut-utility';

export interface InlineSubagentOptions {
  prompt: string;
  cwd?: string;
  model?: string;           // default: opus
  timeoutMs?: number;       // default: 120_000
  systemPrompt?: string;    // optional additional system prompt
  permissionMode?: string;  // default: bypassPermissions
  toolUseId: string;        // parent tool call ID (for event correlation)
  background?: boolean;     // background mode — return immediately after spawn
  /** 'append' (default) rides the full Claude Code system prompt; 'replace'
   *  swaps it for systemPrompt alone. Measured (empty dir, 2026-08-28): the
   *  default shell is 32.5k tokens; replace + tools:['Bash'] +
   *  settingSources:'' is 3.6k. Slim every utility child. */
  systemPromptMode?: 'append' | 'replace';
  /** Restrict the CLI's toolset (--tools). [] = no tools at all;
   *  undefined = the full default set (~20k tokens of tool manuals). */
  tools?: string[];
  /** --effort level; undefined = the CLI's own default for the model. */
  effort?: string;
  /** --setting-sources value. '' = load NO settings and NO CLAUDE.md chain
   *  (the cwd's project CLAUDE.md alone can be tens of KB). undefined = CLI
   *  default (load everything). */
  settingSources?: string;
  /** --bare: skip hooks/LSP/plugins AND the repo-derived context that
   *  settingSources alone does not remove (measured: slim flags in this repo's
   *  cwd still carried 7.9k tokens; +bare = 133). The full slim combo for a
   *  utility child is systemPromptMode:'replace' + tools + settingSources:''
   *  + bare:true. */
  bare?: boolean;
  /** Called for every parsed streaming block (text / tool_call / system) as
   *  the child emits it — lets the caller mirror the child's activity into
   *  its own progress channel. Exceptions are swallowed. */
  onBlock?: (block: StreamingBlock) => void;
  /** false = disable extended thinking for the child (MAX_THINKING_TOKENS=0,
   *  the CLI's own opt-out). Utility children answer a fixed contract — they
   *  don't need to deliberate, and profiled 2026-08-29 a search child spent
   *  3-6s (700-4000 chars) thinking EVERY round. undefined = CLI default. */
  thinking?: boolean;
  /** One-flag preset for utility children: applies the full slim combo
   *  (systemPromptMode 'replace', tools [], settingSources '', bare, neutral
   *  tmpdir cwd) wherever the caller left the field unset — explicit fields
   *  always win (e.g. slim:true + tools:['Bash']). The neutral cwd matters
   *  twice over: it keeps the transcript OUT of the server repo's
   *  ~/.claude/projects dir (so session-import scans never see these
   *  children), and a claude process in the repo cwd could adopt
   *  {cwd}/.claude/scheduled_tasks.json durable crons — adoption is
   *  DIRECTORY-scoped (2026-08-13 incident). */
  slim?: boolean;
}

export interface InlineSubagentResult {
  success: boolean;
  result: string;
  costUsd?: number;
  sessionId?: string;
  error?: string;
  durationMs: number;
  /** Accumulated streaming blocks — available for introspection after completion.
   *  During execution, blocks are also streamed live via AGENT_SUBAGENT_STREAM events. */
  blocks: StreamingBlock[];
}

// ── Concurrency semaphore ──

const MAX_CONCURRENT = 3;
let activeCount = 0;
const waitQueue: Array<() => void> = [];

function acquireSemaphore(): Promise<void> {
  if (activeCount < MAX_CONCURRENT) {
    activeCount++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waitQueue.push(resolve);
  });
}

function releaseSemaphore(): void {
  activeCount--;
  const next = waitQueue.shift();
  if (next) {
    activeCount++;
    next();
  }
}

// ── User-settings env pass-through for settings-less children ──

/** The env block of ~/.claude/settings.json, read once per process. When a
 *  child runs with `--setting-sources ""` it never loads that file, and for
 *  Bedrock users their whole auth (CLAUDE_CODE_USE_BEDROCK, AWS creds) lives
 *  there — so a slim child would fail auth (shipped 502, 2026-08-28). We
 *  re-apply just the env block, exactly the CLI's own semantics (settings
 *  env is assigned OVER process env). */
let userSettingsEnvCache: Record<string, string> | null = null;
let userModelOverridesCache: Record<string, string> | null = null;
function loadUserSettings(): void {
  try {
    const raw = readFileSync(path.join(homedir(), '.claude', 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw) as { env?: Record<string, unknown>; modelOverrides?: Record<string, unknown> };
    const strings = (o: Record<string, unknown> | undefined) => Object.fromEntries(
      Object.entries(o ?? {}).filter(([, v]) => typeof v === 'string'),
    ) as Record<string, string>;
    userSettingsEnvCache = strings(parsed.env);
    userModelOverridesCache = strings(parsed.modelOverrides);
  } catch {
    userSettingsEnvCache = {};
    userModelOverridesCache = {};
  }
}
export function readUserSettingsEnv(): Record<string, string> {
  if (!userSettingsEnvCache) loadUserSettings();
  return userSettingsEnvCache!;
}

/**
 * The `--settings` argument a settings-less child needs so `--model haiku`
 * resolves the way the user's own CLI resolves it. modelOverrides is not an
 * env var, so without this a slim child ignores the user's mapping and runs
 * the CLI's built-in model for the alias: on Bedrock that was Haiku 4.5 and
 * Sonnet 4.5 while every session of the same user ran the 5.5 models
 * (2026-10-07). Undefined when the user has no overrides.
 */
export function slimChildSettingsArg(): string | undefined {
  if (!userModelOverridesCache) loadUserSettings();
  const overrides = userModelOverridesCache!;
  return Object.keys(overrides).length > 0
    ? JSON.stringify({ modelOverrides: overrides })
    : undefined;
}

/** Test hook. */
export function _resetUserSettingsEnvCacheForTesting(): void {
  userSettingsEnvCache = null;
  userModelOverridesCache = null;
}

// ── Core runner ──

export async function runInlineSubagent(opts: InlineSubagentOptions): Promise<InlineSubagentResult> {
  const slim = opts.slim === true;
  const {
    prompt,
    cwd = slim ? tmpdir() : undefined,
    model = 'opus',
    timeoutMs = 120_000,
    systemPrompt,
    permissionMode = 'bypassPermissions',
    toolUseId,
    background = false,
    systemPromptMode = slim ? 'replace' : 'append',
    tools = slim ? [] : undefined,
    settingSources = slim ? '' : undefined,
    bare = slim,
  } = opts;

  await acquireSemaphore();
  const startTime = Date.now();

  // Build CLI args — claude CLI accepts short model names (opus, sonnet, haiku)
  // --allow- form grants the bypass capability WITHOUT selecting it; the bare
  // --dangerously-skip-permissions outranks --permission-mode and would pin
  // every subagent to bypassPermissions regardless of `permissionMode`.
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
    '--allow-dangerously-skip-permissions',
    '--permission-mode', permissionMode,
  ];
  if (opts.effort) args.push('--effort', opts.effort);
  if (systemPrompt) {
    args.push(systemPromptMode === 'replace' ? '--system-prompt' : '--append-system-prompt', systemPrompt);
  }
  if (tools !== undefined) {
    args.push('--tools', tools.join(','));
  }
  if (settingSources !== undefined) {
    args.push('--setting-sources', settingSources);
  }
  if (settingSources === '') {
    const settings = slimChildSettingsArg();
    if (settings) args.push('--settings', settings);
  }
  if (bare) {
    args.push('--bare');
  }

  // Clean env — remove CLAUDECODE to prevent nested session detection.
  // API keys (ANTHROPIC_API_KEY etc.) are intentionally preserved so the subprocess can authenticate.
  const { CLAUDECODE: _drop, ...cleanEnv } = process.env;
  // A settings-less child never reads ~/.claude/settings.json — re-apply its
  // env block (Bedrock auth lives there) with the CLI's own precedence.
  if (settingSources === '') {
    Object.assign(cleanEnv, readUserSettingsEnv());
  }
  // Mark the transcript so the session-import scan never lists this child as
  // an importable session (we spawn MANY of these; they are not user work).
  cleanEnv.CLAUDE_CODE_ENTRYPOINT = WALNUT_UTILITY_ENTRYPOINT;
  // After the settings-env assign on purpose: an explicit thinking:false must
  // win even when the user's settings.json env sets MAX_THINKING_TOKENS.
  if (opts.thinking === false) cleanEnv.MAX_THINKING_TOKENS = '0';

  log.agent.info('inline subagent spawning', {
    toolUseId,
    model,
    promptLength: prompt.length,
    cwd,
    background,
    timeoutMs,
  });

  // Note: we do NOT set CLAUDE_CODE_DISABLE_BACKGROUND_TASKS — background Bash tasks
  // are a useful capability and there's no reason to disable them for subagents.
  // The child runs in the local daemon (oneshot-client.ts), the prompt on its stdin.

  // State tracking
  let initData: ClaudeStreamInit | undefined;
  let resultData: ClaudeStreamResult | undefined;
  let blocks: StreamingBlock[] = [];

  const onLine = (line: string) => {
    const parsed = parseClaudeJsonlLine(line, {
      onInit: (init) => { initData = init; },
      onResult: (result) => { resultData = result; },
    });

    if (!parsed) return;

    // Flatten array results
    const blockList = Array.isArray(parsed) ? parsed : [parsed];
    for (const block of blockList) {
      // Accumulate (merges tool results with tool calls)
      blocks = accumulateBlock(blocks, block);

      try { opts.onBlock?.(block); } catch { /* a listener must never break the stream */ }

      // Emit streaming event to frontend
      bus.emit(EventNames.AGENT_SUBAGENT_STREAM, {
        toolUseId,
        block,
      }, ['web-ui'], { source: 'inline-subagent' });
    }
  };

  // Collect stderr for error diagnostics (capped to prevent unbounded growth)
  let stderr = '';
  const STDERR_MAX = 10_000;

  let exited!: (exit: OneShotExit) => void;
  const exit = new Promise<OneShotExit>((resolve) => { exited = resolve; });
  let proc: OneShotHandle;
  try {
    proc = await startOneShot({
      command: resolveClaudeCliExecutable() ?? claudeFallbackCommand(),
      args,
      cwd: cwd ?? process.cwd(),
      env: cleanEnv,
      input: prompt,
      endInput: true,
      maxMs: timeoutMs + 30_000,
    }, {
      onLine,
      onStderr: (text) => { if (stderr.length < STDERR_MAX) stderr += text; },
      onExit: (e) => {
        if (e.error && stderr.length < STDERR_MAX) stderr += e.error;
        exited(e);
      },
    });
  } catch (err) {
    releaseSemaphore();
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, result: message, error: message, durationMs: Date.now() - startTime, blocks: [] };
  }

  // If background mode, return immediately with a handle.
  // Note: semaphore slot is held until the background process completes,
  // so background jobs count against the max 3 concurrent limit.
  if (background) {
    const bgPromise = waitForExit(proc, exit, timeoutMs, toolUseId);
    bgPromise.then((exitCode) => {
      releaseSemaphore();
      const durationMs = Date.now() - startTime;
      const success = exitCode === 0 && !resultData?.isError;
      const result = resultData?.result ?? (success ? 'Completed' : `Error (exit ${exitCode})`);

      log.agent.info('inline subagent background completed', {
        toolUseId,
        success,
        durationMs,
        costUsd: resultData?.costUsd,
      });

      // Notify frontend via event bus
      bus.emit(EventNames.AGENT_SUBAGENT_STREAM, {
        toolUseId,
        block: {
          type: 'system',
          variant: success ? 'compact' : 'error',
          message: `Background subagent ${success ? 'completed' : 'failed'}: ${result.slice(0, 200)}`,
        } satisfies StreamingBlock,
      }, ['web-ui'], { source: 'inline-subagent' });
    }).catch(() => {
      // waitForExit never rejects: only the callback above can land here, and it released already.
    });

    return {
      success: true,
      result: `Subagent started in background (model: ${model}). Results will appear in the agent box when complete.`,
      durationMs: Date.now() - startTime,
      blocks: [],
      sessionId: initData?.sessionId,
    };
  }

  // Foreground mode — wait for completion
  const exitCode = await waitForExit(proc, exit, timeoutMs, toolUseId);
  releaseSemaphore();

  const durationMs = Date.now() - startTime;
  const success = exitCode === 0 && !resultData?.isError;
  const result = resultData?.result
    ?? (success ? 'Completed (no result text)' : `Error: exit code ${exitCode}${stderr ? ` — ${stderr.slice(0, 500)}` : ''}`);

  log.agent.info('inline subagent completed', {
    toolUseId,
    success,
    durationMs,
    costUsd: resultData?.costUsd,
    exitCode,
    blocksCount: blocks.length,
  });

  return {
    success,
    result,
    costUsd: resultData?.costUsd,
    sessionId: initData?.sessionId,
    durationMs,
    blocks,
    error: success ? undefined : result,
  };
}

/** Wait for process exit with timeout and two-phase kill */
function waitForExit(
  proc: OneShotHandle,
  exit: Promise<OneShotExit>,
  timeoutMs: number,
  toolUseId: string,
): Promise<number | null> {
  return new Promise((resolve) => {
    let resolved = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    // Timeout — two-phase kill
    const timer = setTimeout(() => {
      if (resolved) return;
      log.agent.warn('inline subagent timeout — sending SIGINT', { toolUseId, timeoutMs });

      proc.kill('SIGINT');

      // Give 3s for graceful shutdown, then SIGTERM
      killTimer = setTimeout(() => {
        if (resolved) return;
        log.agent.warn('inline subagent force kill — sending SIGTERM', { toolUseId });
        proc.kill('SIGTERM');
      }, 3000);
    }, timeoutMs);

    void exit.then((e) => {
      resolved = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (e.error) log.agent.error('inline subagent process error', { toolUseId, error: e.error });
      resolve(e.error ? 1 : e.code);
    });
  });
}
