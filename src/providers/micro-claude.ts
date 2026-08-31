/**
 * Micro Claude — the "minimum Claude Code" pattern (user decision 2026-08-28).
 *
 * When a feature needs a quick model turn, run it on Claude Code itself, NOT
 * a hand-rolled API loop: the CLI already owns credentials (subscription or
 * whatever the user configured), so features built on it need zero extra auth
 * setup. What makes it cheap enough for utility work is stripping everything
 * unnecessary — this wrapper pins that combo so callers can't forget half of
 * it:
 *
 *   - `slim` preset (inline-subagent): REPLACED system prompt, --bare, no
 *     settings/CLAUDE.md chain, neutral tmpdir cwd. Measured: a stock child
 *     carries ~32.5k tokens of prefix into EVERY model round; slim is ~3.6k
 *     with Bash, 133 tokens with no tools.
 *   - tools default to NONE — pass ['Bash'] only if the child genuinely needs
 *     a shell. Every enabled tool adds its manual to the per-round prefix.
 *   - the walnut-utility entrypoint marker rides along automatically, so
 *     these children never appear in the session-import scan.
 *   - `onBlock` exposes the child's stream (text / tool_call) for live
 *     progress UI.
 *
 * First consumer: the ✦ AI task-search lane (core/task-search-agent.ts).
 * The in-process alternative (agent/micro-agent.ts) stays for callers that
 * explicitly want no subprocess, but micro-Claude is the default pattern.
 */

import { randomUUID } from 'node:crypto';
import { runInlineSubagent } from './inline-subagent.js';
import { runWarmMicroClaude } from './micro-claude-warm.js';
import type { StreamingBlock } from './claude-stream-parser.js';

export interface MicroClaudeOptions {
  /** Small, caller-owned system prompt — REPLACES the CLI's own. */
  system: string;
  prompt: string;
  /** CLI model name (sonnet/haiku/opus or a full id). Default: sonnet. */
  model?: string;
  timeoutMs?: number;
  /** CLI tool names to keep. Default NONE — each tool manual costs prefix
   *  tokens in every round. ['Bash'] covers most utility children. */
  tools?: string[];
  /** Extended thinking for the child. Default FALSE — a utility child answers
   *  a fixed contract, and thinking costs 3-6s per model round (profiled on
   *  the search lane). Pass true only when the task genuinely needs it.
   *  Ignored on the warm path (warm children are always thinking-off). */
  thinking?: boolean;
  /** Ride the pre-booted child pool (micro-claude-warm.ts): saves the
   *  ~2-2.5s CLI boot when a pooled child is available (POC: 4.6s → 2.0s
   *  send→result). */
  warm?: boolean;
  /** Live stream mirror (text / tool_call blocks) for progress UI. */
  onBlock?: (block: StreamingBlock) => void;
  /** For event correlation; defaults to a fresh micro-claude-<uuid>. */
  toolUseId?: string;
}

export interface MicroClaudeResult {
  response: string;
  costUsd?: number;
  durationMs: number;
}

const DEFAULT_MODEL = 'sonnet';
const DEFAULT_TIMEOUT_MS = 60_000;

/** Run one slim claude -p turn. Throws on a failed/killed child. */
export async function runMicroClaude(opts: MicroClaudeOptions): Promise<MicroClaudeResult> {
  if (opts.warm) {
    const run = await runWarmMicroClaude({
      system: opts.system,
      model: opts.model ?? DEFAULT_MODEL,
      tools: opts.tools ?? [],
      prompt: opts.prompt,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      toolUseId: opts.toolUseId ?? `micro-claude-${randomUUID()}`,
      ...(opts.onBlock ? { onBlock: opts.onBlock } : {}),
    });
    return { response: run.response, costUsd: run.costUsd, durationMs: run.durationMs };
  }
  const run = await runInlineSubagent({
    prompt: opts.prompt,
    systemPrompt: opts.system,
    model: opts.model ?? DEFAULT_MODEL,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    toolUseId: opts.toolUseId ?? `micro-claude-${randomUUID()}`,
    slim: true,
    thinking: opts.thinking ?? false,
    ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
    ...(opts.onBlock ? { onBlock: opts.onBlock } : {}),
  });
  if (!run.success) throw new Error(run.error ?? 'claude -p exited with an error');
  return { response: run.result, costUsd: run.costUsd, durationMs: run.durationMs };
}
