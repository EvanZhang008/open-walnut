/**
 * Inline Subagent — lightweight Claude Code subprocess runner.
 *
 * Spawns `claude -p --output-format stream-json` and streams JSONL output
 * as StreamingBlock events via the event bus. Used by the `create_subagent`
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

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { bus, EventNames } from '../core/event-bus.js';
import { log } from '../logging/index.js';
import {
  parseClaudeJsonlLine,
  accumulateBlock,
  type StreamingBlock,
  type ClaudeStreamInit,
  type ClaudeStreamResult,
} from './claude-stream-parser.js';

// ── Types ──

export interface InlineSubagentOptions {
  prompt: string;
  cwd?: string;
  model?: string;           // default: opus
  timeoutMs?: number;       // default: 120_000
  systemPrompt?: string;    // optional additional system prompt
  permissionMode?: string;  // default: bypassPermissions
  toolUseId: string;        // parent tool call ID (for event correlation)
  background?: boolean;     // background mode — return immediately after spawn
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

// ── Track active processes for cleanup ──

const activeProcesses = new Set<ChildProcess>();

// Use once() to avoid listener accumulation across hot-reloads / test runs
process.once('exit', () => {
  for (const proc of activeProcesses) {
    try { proc.kill('SIGTERM'); } catch {}
  }
});

// ── Core runner ──

export async function runInlineSubagent(opts: InlineSubagentOptions): Promise<InlineSubagentResult> {
  const {
    prompt,
    cwd,
    model = 'opus',
    timeoutMs = 120_000,
    systemPrompt,
    permissionMode = 'bypassPermissions',
    toolUseId,
    background = false,
  } = opts;

  await acquireSemaphore();
  const startTime = Date.now();

  // Build CLI args — claude CLI accepts short model names (opus, sonnet, haiku)
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
    '--permission-mode', permissionMode,
  ];
  if (systemPrompt) {
    args.push('--append-system-prompt', systemPrompt);
  }

  // Clean env — remove CLAUDECODE to prevent nested session detection.
  // API keys (ANTHROPIC_API_KEY etc.) are intentionally preserved so the subprocess can authenticate.
  const { CLAUDECODE: _drop, ...cleanEnv } = process.env;

  log.agent.info('inline subagent spawning', {
    toolUseId,
    model,
    promptLength: prompt.length,
    cwd,
    background,
    timeoutMs,
  });

  const proc = spawn('claude', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: cwd ?? process.cwd(),
    env: { ...cleanEnv, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
  });

  activeProcesses.add(proc);

  // Write prompt to stdin and close
  proc.stdin?.write(prompt);
  proc.stdin?.end();

  // State tracking
  let initData: ClaudeStreamInit | undefined;
  let resultData: ClaudeStreamResult | undefined;
  let blocks: StreamingBlock[] = [];

  // Parse JSONL output line by line
  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });

  rl.on('line', (line) => {
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

      // Emit streaming event to frontend
      bus.emit(EventNames.AGENT_SUBAGENT_STREAM, {
        toolUseId,
        block,
      }, ['web-ui'], { source: 'inline-subagent' });
    }
  });

  // Collect stderr for error diagnostics (capped to prevent unbounded growth)
  let stderr = '';
  const STDERR_MAX = 10_000;
  proc.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < STDERR_MAX) stderr += chunk.toString();
  });

  // If background mode, return immediately with a handle.
  // Note: semaphore slot is held until the background process completes,
  // so background jobs count against the max 3 concurrent limit.
  if (background) {
    const bgPromise = waitForExit(proc, rl, timeoutMs, toolUseId);
    bgPromise.then((exitCode) => {
      activeProcesses.delete(proc);
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
      activeProcesses.delete(proc);
      releaseSemaphore();
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
  const exitCode = await waitForExit(proc, rl, timeoutMs, toolUseId);
  activeProcesses.delete(proc);
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
  proc: ChildProcess,
  rl: ReturnType<typeof createInterface>,
  timeoutMs: number,
  toolUseId: string,
): Promise<number | null> {
  return new Promise((resolve) => {
    let resolved = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      rl.close();
    };

    proc.on('exit', (code) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(code);
    });

    proc.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      log.agent.error('inline subagent process error', { toolUseId, error: err.message });
      resolve(1);
    });

    // Timeout — two-phase kill
    timer = setTimeout(() => {
      if (resolved) return;
      log.agent.warn('inline subagent timeout — sending SIGINT', { toolUseId, timeoutMs });

      try { proc.kill('SIGINT'); } catch {}

      // Give 3s for graceful shutdown, then SIGTERM
      killTimer = setTimeout(() => {
        if (resolved) return;
        log.agent.warn('inline subagent force kill — sending SIGTERM', { toolUseId });
        try { proc.kill('SIGTERM'); } catch {}
      }, 3000);
    }, timeoutMs);
  });
}
