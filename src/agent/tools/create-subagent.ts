/**
 * create_subagent tool — spawn a lightweight Claude Code subprocess.
 *
 * Shows as a collapsible agent box in the main chat with streaming output.
 * Unlike start_session, no task is required and no persistent session is created.
 */

import { randomBytes } from 'node:crypto';
import type { ToolDefinition, ToolResultContent, ToolExecuteMeta } from '../tools.js';
import { runInlineSubagent } from '../../providers/inline-subagent.js';

const VALID_MODELS = new Set(['opus', 'sonnet', 'haiku']);

export const createSubagentTool: ToolDefinition = {
  name: 'create_subagent',
  description: `Spawn a lightweight Claude Code subprocess whose result returns INLINE to THIS conversation.
No task required. No persistent session created. Shows as a collapsible agent box in chat with streaming output.
The subagent has access to ALL Claude Code tools (file read/write, bash, grep, glob, etc.).

USE FOR: Quick research, file analysis, codebase investigation, one-shot questions, validating paths,
running commands with AI interpretation, gathering context before starting a session (e.g., explore
a codebase to find the right paths/files/patterns before kicking off a start_session for implementation).

DO NOT USE FOR: Multi-round coding, work that needs task tracking, implementation requiring conversation
history — use start_session instead, which creates a persistent background session.

Key difference:
  create_subagent → result comes back to YOU (inline in this conversation)
  start_session   → result goes to a SEPARATE session panel (background, async, needs a task)

Two modes:
  Foreground (default): Blocks until the subagent finishes. Result returned directly.
  Background (background=true): Spawns and returns immediately. Use when you don't need to wait.

Default model is opus. Use sonnet for simple tasks, haiku for trivial lookups.
Default timeout is 120 seconds (max 600).`,
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Task or question for the subagent. Be specific — include file paths, context, and expected output format.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the subagent. Defaults to the current working directory.',
      },
      model: {
        type: 'string',
        enum: ['opus', 'sonnet', 'haiku'],
        description: 'Model to use. Default: opus. Use sonnet for simple tasks, haiku for trivial lookups.',
      },
      timeout_secs: {
        type: 'number',
        description: 'Timeout in seconds. Default: 120, max: 600.',
        maximum: 600,
      },
      background: {
        type: 'boolean',
        description: 'Run in background — return immediately, results appear in the agent box when done. Default: false.',
      },
      system_prompt: {
        type: 'string',
        description: 'Additional system prompt context appended to the subagent\'s system prompt.',
      },
    },
    required: ['prompt'],
  },

  async execute(params: Record<string, unknown>, meta?: ToolExecuteMeta): Promise<ToolResultContent> {
    const prompt = params.prompt as string;
    if (!prompt?.trim()) {
      return 'Error: prompt is required and cannot be empty.';
    }

    // Validate model against allowlist
    const rawModel = typeof params.model === 'string' ? params.model : 'opus';
    const model = VALID_MODELS.has(rawModel) ? rawModel : 'opus';

    // Handle timeout_secs: 0 correctly (don't treat as falsy)
    const rawTimeout = params.timeout_secs != null ? Number(params.timeout_secs) : 120;
    const timeoutSecs = Math.min(Math.max(isNaN(rawTimeout) ? 120 : rawTimeout, 10), 600);

    const result = await runInlineSubagent({
      prompt,
      cwd: params.cwd as string | undefined,
      model,
      timeoutMs: timeoutSecs * 1000,
      systemPrompt: params.system_prompt as string | undefined,
      toolUseId: meta?.toolUseId ?? `subagent-${randomBytes(6).toString('hex')}`,
      background: params.background === true,
    });

    if (result.success) {
      const parts = [result.result];
      if (result.costUsd !== undefined) {
        parts.push(`\n[Cost: $${result.costUsd.toFixed(4)} | Duration: ${(result.durationMs / 1000).toFixed(1)}s]`);
      }
      return parts.join('');
    }

    return `Error: ${result.error ?? 'Subagent failed'}`;
  },
};
