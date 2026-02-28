/**
 * Session History Reader — reads Claude Code's JSONL conversation files.
 *
 * Claude Code stores session history at:
 *   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 *
 * Path encoding: /Users/foo/bar → -Users-foo-bar (replace / with -)
 *
 * File access for both local and remote sessions is handled by
 * SessionFileReader (session-file-reader.ts).
 */

import fs from 'node:fs';
import { log } from '../logging/index.js';
import {
  encodeProjectPath,
  findLocalJsonlPath,
  readSessionJsonlContent,
  readSubagentContents,
} from './session-file-reader.js';
import { rewriteRemoteImagePaths } from '../providers/session-io.js';
import type { SshTarget } from '../providers/session-io.js';

// Re-export for backward compatibility
export { encodeProjectPath };
export { findLocalJsonlPath as findSessionJsonlPath } from './session-file-reader.js';

export interface SessionHistoryTool {
  name: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  result?: string;
  planContent?: string;
  /** agentId extracted from Task tool_result — links to subagent JSONL */
  agentId?: string;
  /** Child messages from subagent JSONL (populated for Task tools) */
  childMessages?: SessionHistoryMessage[];
}

export interface SessionHistoryMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  tools?: SessionHistoryTool[];
  thinking?: string;
  model?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

// ── Internal: raw JSONL line shape ──

interface RawJsonlLine {
  type: string;
  uuid?: string;
  timestamp?: string;
  parent_tool_use_id?: string | null;
  // queue-operation fields (FIFO-injected user messages)
  operation?: string;
  content?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    usage?: { input_tokens: number; output_tokens: number };
    content?: string | Array<{
      type: string;
      text?: string;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
      thinking?: string;
      // tool_result fields
      tool_use_id?: string;
      content?: string | Array<{ type: string; text?: string }>;
    }>;
  };
}

/**
 * Core parsing logic: parse raw JSONL content string into SessionHistoryMessage[].
 * Deduplicates by message.id, handles queue-operations.
 */
function parseSessionMessages(content: string): SessionHistoryMessage[] {
  const lines = content.split('\n').filter(Boolean);

  // Parse all lines
  const rawMessages: RawJsonlLine[] = [];
  for (const line of lines) {
    try {
      rawMessages.push(JSON.parse(line));
    } catch {
      // Skip unparseable lines
    }
  }

  // Filter to user/assistant message types and deduplicate by message.id
  // (assistant messages can span multiple JSONL lines sharing the same message.id)
  const messageMap = new Map<string, {
    role: string;
    timestamp: string;
    model?: string;
    usage?: { input_tokens: number; output_tokens: number };
    contentBlocks: Array<{
      type: string;
      text?: string;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
      thinking?: string;
      tool_use_id?: string;
      content?: string | Array<{ type: string; text?: string }>;
    }>;
  }>();

  // First pass: identify Pattern A enqueue entries (those followed by a 'dequeue').
  // Pattern A: enqueue → dequeue → user STRING (FIFO order, user STRING follows)
  // Pattern B: enqueue → remove (or unmatched) — no user STRING, must be parsed here.
  // We use FIFO matching: dequeue consumes the oldest enqueue and marks it to skip.
  // remove consumes the oldest enqueue without marking (it's a Pattern B cleanup).
  const enqueueFifo: number[] = [];
  const skipEnqueueIndices = new Set<number>();
  for (let i = 0; i < rawMessages.length; i++) {
    const raw = rawMessages[i];
    if (raw.type !== 'queue-operation') continue;
    if (raw.operation === 'enqueue') {
      enqueueFifo.push(i);
    } else if (raw.operation === 'dequeue') {
      // Pattern A: a user STRING will follow — skip this enqueue
      const oldest = enqueueFifo.shift();
      if (oldest !== undefined) skipEnqueueIndices.add(oldest);
    } else if (raw.operation === 'remove') {
      // Pattern B cleanup: consumed mid-stream, no user STRING — pop but don't skip
      enqueueFifo.shift();
    }
  }

  for (let i = 0; i < rawMessages.length; i++) {
    const raw = rawMessages[i];

    // Handle queue-operation entries (FIFO-injected user messages from mid-stream send).
    // These are interleaved at the correct chronological position in the JSONL.
    if (raw.type === 'queue-operation') {
      // Only parse Pattern B enqueues (no corresponding dequeue — no user STRING follows).
      // Pattern A enqueues are in skipEnqueueIndices and will have a proper user STRING.
      if (raw.operation === 'enqueue' && raw.content && !skipEnqueueIndices.has(i)) {
        const syntheticId = `queue-${raw.timestamp ?? i}`;
        messageMap.set(syntheticId, {
          role: 'user',
          timestamp: raw.timestamp ?? new Date().toISOString(),
          contentBlocks: [{ type: 'text' as const, text: raw.content }],
        });
      }
      continue;
    }

    if (!raw.message?.role || !['user', 'assistant'].includes(raw.message.role)) continue;

    const msgId = raw.message.id ?? raw.uuid ?? `${raw.timestamp}-${rawMessages.indexOf(raw)}`;
    const existing = messageMap.get(msgId);

    if (existing) {
      // Merge content blocks from duplicate lines
      if (raw.message.content) {
        const blocks = typeof raw.message.content === 'string'
          ? [{ type: 'text' as const, text: raw.message.content }]
          : raw.message.content;
        existing.contentBlocks.push(...blocks);
      }
      if (raw.message.usage) {
        existing.usage = raw.message.usage;
      }
    } else {
      messageMap.set(msgId, {
        role: raw.message.role,
        timestamp: raw.timestamp ?? new Date().toISOString(),
        model: raw.message.model,
        usage: raw.message.usage,
        contentBlocks: raw.message.content
          ? (typeof raw.message.content === 'string'
            ? [{ type: 'text' as const, text: raw.message.content }]
            : [...raw.message.content])
          : [],
      });
    }
  }

  // ── Build tool_use_id → tool_result text mapping ──
  // Scan all user messages for tool_result blocks and extract their text content.
  // This lets us associate tool results with their corresponding tool_use blocks.
  const toolResultMap = new Map<string, string>();
  for (const [, msg] of messageMap) {
    if (msg.role !== 'user') continue;
    for (const block of msg.contentBlocks) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        // Extract text from nested content array or direct string
        const nested = (block as Record<string, unknown>).content;
        let resultText = '';
        if (typeof nested === 'string') {
          resultText = nested;
        } else if (Array.isArray(nested)) {
          resultText = (nested as Array<{ type: string; text?: string }>)
            .filter(c => c.type === 'text' && c.text)
            .map(c => c.text!)
            .join('\n');
        }
        if (resultText) {
          toolResultMap.set(block.tool_use_id, resultText);
        }
      }
    }
  }

  // Convert to SessionHistoryMessage array
  // Track the last plan content written to ~/.claude/plans/ across messages
  let lastPlanContent: string | null = null;

  const result: SessionHistoryMessage[] = [];
  for (const [, msg] of messageMap) {
    const textParts: string[] = [];
    const tools: SessionHistoryTool[] = [];
    let thinking: string | undefined;

    for (const block of msg.contentBlocks) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'tool_use' && block.name) {
        const toolUseId = block.id;
        // Look up the result for this tool_use
        const toolResult = toolUseId ? toolResultMap.get(toolUseId) : undefined;

        // Extract agentId from Task tool results.
        // The canonical pattern is the LAST "agentId: XXX (for resuming...)" line.
        // Earlier occurrences may be from quoted JSON examples in the result text.
        let agentId: string | undefined;
        if (block.name === 'Task' && toolResult) {
          const matches = [...toolResult.matchAll(/agentId:\s*([a-f0-9]+)/g)];
          if (matches.length > 0) agentId = matches[matches.length - 1][1];
        }

        // Capture plan content from Write tool targeting ~/.claude/plans/
        if (block.name === 'Write' && typeof block.input?.file_path === 'string'
          && block.input.file_path.includes('.claude/plans/')
          && typeof block.input.content === 'string' && block.input.content) {
          lastPlanContent = block.input.content;
          // Strip large content from the tool input to avoid showing it twice
          tools.push({ name: block.name, input: { ...block.input, content: '(see plan below)' }, toolUseId });
        } else if (block.name === 'ExitPlanMode') {
          // Attach plan content: prefer captured Write content, fall back to input.plan
          const planContent = lastPlanContent
            ?? (typeof block.input?.plan === 'string' && block.input.plan ? block.input.plan : undefined);
          const cleanInput = planContent && block.input?.plan
            ? { ...block.input, plan: '(see plan below)' }
            : (block.input ?? {});
          tools.push({
            name: block.name,
            input: cleanInput,
            toolUseId,
            ...(planContent ? { planContent } : {}),
          });
        } else {
          tools.push({
            name: block.name,
            input: block.input ?? {},
            toolUseId,
            ...(toolResult ? { result: toolResult.slice(0, 5000) } : {}),
            ...(agentId ? { agentId } : {}),
          });
        }
      } else if (block.type === 'thinking' && block.thinking) {
        thinking = (thinking ? thinking + '\n' : '') + block.thinking;
      }
    }

    const text = textParts.join('\n');

    // Skip messages with no visible content (e.g. tool_result-only user entries,
    // empty heartbeat lines). These produce ghost "You" bubbles in the UI.
    if (!text && tools.length === 0 && !thinking) continue;

    result.push({
      role: msg.role as 'user' | 'assistant',
      text,
      timestamp: msg.timestamp,
      ...(tools.length > 0 ? { tools } : {}),
      ...(thinking ? { thinking } : {}),
      ...(msg.model ? { model: msg.model } : {}),
      ...(msg.usage ? { usage: msg.usage } : {}),
    });
  }

  return result;
}

/**
 * Read subagent messages for a session (local or remote).
 * Uses readSubagentContents() from session-file-reader for transparent access.
 *
 * Returns a Map<agentId, SessionHistoryMessage[]> with parsed child messages.
 */
async function readSubagentMessages(sessionId: string, cwd?: string, host?: string): Promise<Map<string, SessionHistoryMessage[]>> {
  const result = new Map<string, SessionHistoryMessage[]>();

  const rawContents = await readSubagentContents(sessionId, cwd, host);
  for (const [agentId, content] of rawContents) {
    try {
      const messages = parseSessionMessages(content);
      if (messages.length > 0) {
        result.set(agentId, messages);
      }
    } catch (err) {
      log.session.debug('failed to parse subagent JSONL', {
        sessionId, agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/**
 * Attach subagent child messages to their parent Task tool_use blocks.
 * Mutates the messages array in-place by populating tool.childMessages.
 */
function attachSubagentMessages(messages: SessionHistoryMessage[], subagentMap: Map<string, SessionHistoryMessage[]>): void {
  if (subagentMap.size === 0) return;
  for (const msg of messages) {
    if (!msg.tools) continue;
    for (const tool of msg.tools) {
      if (tool.name === 'Task' && tool.agentId && subagentMap.has(tool.agentId)) {
        tool.childMessages = subagentMap.get(tool.agentId);
      }
    }
  }
}

/**
 * Read and parse session history from Claude Code's JSONL file.
 * Returns an ordered array of user/assistant messages.
 *
 * Uses readSessionJsonlContent() for transparent local/remote file access.
 * When `host` is provided, falls back to reading from the remote host via SSH.
 */
export async function readSessionHistory(sessionId: string, cwd?: string, host?: string, outputFile?: string): Promise<SessionHistoryMessage[]> {
  let messages: SessionHistoryMessage[] | null = null;

  const result = await readSessionJsonlContent(sessionId, cwd, host, outputFile);
  if (result) {
    try {
      messages = parseSessionMessages(result.content);
    } catch (err) {
      log.session.warn('failed to parse session history', {
        sessionId, source: result.source,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!messages) return [];

  // Attach subagent child messages (works for both local and remote sessions)
  const hasTaskTools = messages.some(m => m.tools?.some(t => t.name === 'Task' && t.agentId));
  if (hasTaskTools) {
    const subagentMap = await readSubagentMessages(sessionId, cwd, host);
    attachSubagentMessages(messages, subagentMap);
  }

  return messages;
}

/**
 * Extract only the plan content from a session's JSONL file.
 * Scans for Write→~/.claude/plans/ and ExitPlanMode tool_use blocks
 * without building the full message array — lightweight fast path.
 *
 * Supports both local and remote sessions via readSessionJsonlContent().
 */
export async function extractPlanContent(sessionId: string, cwd?: string, host?: string): Promise<string | null> {
  // Try local first (fast path)
  const localPath = findLocalJsonlPath(sessionId, cwd);
  let content: string | undefined;

  if (localPath) {
    try {
      content = fs.readFileSync(localPath, 'utf-8');
    } catch { /* fall through */ }
  }

  // If no local content and host provided, try remote
  if (!content && host) {
    const result = await readSessionJsonlContent(sessionId, cwd, host);
    if (result) content = result.content;
  }

  if (!content) return null;

  try {
    const lines = content.split('\n').filter(Boolean);

    let lastWrittenPlan: string | null = null;
    let exitPlanContent: string | null = null;

    for (const line of lines) {
      let parsed: RawJsonlLine;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (!parsed.message?.content || typeof parsed.message.content === 'string') continue;

      for (const block of parsed.message.content) {
        if (block.type !== 'tool_use') continue;

        // Capture Write to ~/.claude/plans/
        if (block.name === 'Write'
          && typeof block.input?.file_path === 'string'
          && block.input.file_path.includes('.claude/plans/')
          && typeof block.input?.content === 'string'
          && block.input.content) {
          lastWrittenPlan = block.input.content;
        }

        // Capture ExitPlanMode
        if (block.name === 'ExitPlanMode') {
          exitPlanContent = typeof block.input?.plan === 'string' && block.input.plan
            ? block.input.plan
            : null;
        }
      }
    }

    // Prefer Write content (richer), fall back to ExitPlanMode.input.plan
    return lastWrittenPlan ?? exitPlanContent;
  } catch (err) {
    log.session.warn('failed to extract plan content', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── State recovery from CloudCode canonical JSONL ──

/**
 * Map Claude CLI permissionMode string to our SessionMode.
 * CloudCode JSONL uses 'bypassPermissions' / 'acceptEdits' / 'plan' / 'default'.
 */
function mapPermissionModeFromJsonl(permMode: string): string | null {
  switch (permMode) {
  case 'bypassPermissions': return 'bypass';
  case 'acceptEdits': return 'accept';
  case 'plan': return 'plan';
  case 'default': return 'default';
  default: return null;
  }
}

/** State recovered from CloudCode canonical JSONL for crash recovery. */
export interface RecoveredSessionState {
  mode?: string;
  planFile?: string;
  planCompleted?: boolean;
  activity?: string;
  /** 'error' or 'agent_complete' if a result event was found. */
  workStatus?: string;
}

/**
 * Extract latest session state from CloudCode's canonical JSONL file.
 *
 * Used by attachToExisting() on server restart to recover state that may not
 * have been persisted to sessions.json before a crash. Reads the source of
 * truth (Claude CLI's own JSONL) instead of our potentially-incomplete stream
 * capture file.
 *
 * Supports both local and remote sessions via readSessionJsonlContent().
 * Scans forward through the file, keeping only the LAST value of each field.
 */
export async function recoverStateFromJsonl(sessionId: string, cwd?: string, host?: string): Promise<RecoveredSessionState | null> {
  // Try local first (fast path — most common case for crash recovery)
  const localPath = findLocalJsonlPath(sessionId, cwd);
  let content: string | undefined;

  if (localPath) {
    try {
      content = fs.readFileSync(localPath, 'utf-8');
    } catch { /* fall through */ }
  }

  // If no local content and host provided, try remote
  if (!content && host) {
    const result = await readSessionJsonlContent(sessionId, cwd, host);
    if (result) content = result.content;
  }

  if (!content) return null;

  try {
    const lines = content.split('\n').filter(Boolean);

    const state: RecoveredSessionState = {};

    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const type = parsed.type as string | undefined;

      // ── permissionMode: CLI ground truth for session mode ──
      // The `permissionMode` field appears on 'user' type lines (set at send time)
      // and occasionally on 'system' status events. We read it from ALL line types
      // because it's the CLI's own report of what mode it's running in.
      //
      // However, this is NOT a complete picture — see EnterPlanMode detection below.
      if (typeof parsed.permissionMode === 'string') {
        const mapped = mapPermissionModeFromJsonl(parsed.permissionMode);
        if (mapped) state.mode = mapped;
      }

      if (type === 'user') {
        // A user message after a result means the session was resumed —
        // clear workStatus so we don't incorrectly report agent_complete.
        if (state.workStatus) {
          state.workStatus = undefined;
          state.activity = undefined;
        }
      }

      // result events indicate turn completion
      if (type === 'result') {
        state.workStatus = (parsed as Record<string, unknown>).is_error ? 'error' : 'agent_complete';
      }

      // Scan assistant messages for tool_use blocks
      if (type === 'assistant') {
        const msg = (parsed as Record<string, unknown>).message as Record<string, unknown> | undefined;
        const blocks = msg?.content;
        if (!Array.isArray(blocks)) continue;

        for (const block of blocks) {
          if (block.type !== 'tool_use') continue;

          const name = block.name as string;
          state.activity = `Using ${name}`;

          // ── EnterPlanMode: mid-turn mode change detection ──
          // When Claude calls EnterPlanMode, the CLI switches to plan mode and emits
          // a `system subtype=status permissionMode=plan` event in the STREAM output.
          // However, this system status event is NOT written to the CloudCode canonical
          // JSONL (~/.claude/projects/.../*.jsonl) — only to Walnut's stream copy.
          //
          // The canonical JSONL only records `permissionMode` on `user` type lines
          // (set at the time the message was sent). If EnterPlanMode happens mid-turn
          // (same turn as the user message), the user line still says the OLD mode
          // (e.g., bypassPermissions), and no subsequent line corrects it.
          //
          // Therefore we detect EnterPlanMode from the tool_use block as the
          // authoritative signal that the session switched to plan mode.
          if (name === 'EnterPlanMode') {
            state.mode = 'plan';
          }

          // Write to ~/.claude/plans/ → planFile
          if (name === 'Write'
            && typeof block.input?.file_path === 'string'
            && block.input.file_path.includes('.claude/plans/')) {
            state.planFile = block.input.file_path;
          }

          // ── ExitPlanMode: plan is done, but mode does NOT change ──
          // In `-p` (non-interactive) mode, ExitPlanMode returns is_error=true
          // because the CLI needs an interactive user to approve the plan exit.
          // The CLI does NOT actually switch permission modes — it stays in plan.
          // It also does NOT emit a system status event for this.
          //
          // So we only set planCompleted=true here. The mode stays whatever it was
          // (typically 'plan' from EnterPlanMode above). We do NOT set mode='bypass'
          // because the CLI never said it switched — and a bypass session that
          // voluntarily called EnterPlanMode→ExitPlanMode should keep its original
          // bypass mode, not be incorrectly labeled as plan.
          if (name === 'ExitPlanMode') {
            state.planCompleted = true;
          }
        }
      }
    }

    return state;
  } catch (err) {
    log.session.warn('failed to recover state from canonical JSONL', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Read session history with reverse pagination (page 1 = most recent messages).
 * Reuses readSessionHistory() for the full parse (including SSH fallback), then slices.
 */
export async function readSessionHistoryPaginated(
  sessionId: string,
  cwd?: string,
  opts?: { pageSize: number; page: number },
  host?: string,
  outputFile?: string,
): Promise<{ messages: SessionHistoryMessage[]; pagination: PaginationMeta }> {
  const pageSize = opts?.pageSize ?? 20;
  const page = opts?.page ?? 1;

  try {
    const allMessages = await readSessionHistory(sessionId, cwd, host, outputFile);
    const total = allMessages.length;
    const totalPages = Math.ceil(total / pageSize);

    if (total === 0) {
      return { messages: [], pagination: { page, pageSize, total: 0, totalPages: 0 } };
    }

    // Reverse order: page 1 = newest, page N = oldest
    const reversed = [...allMessages].reverse();
    const start = (page - 1) * pageSize;
    const messages = reversed.slice(start, start + pageSize);

    return {
      messages,
      pagination: { page, pageSize, total, totalPages },
    };
  } catch (err) {
    log.session.warn('failed to read session history (paginated)', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { messages: [], pagination: { page, pageSize, total: 0, totalPages: 0 } };
  }
}

/**
 * Rewrite remote image paths in session history messages to local paths.
 * Used when replaying history for a remote session — downloads images that
 * aren't already cached locally and rewrites paths so the UI can render them.
 */
export async function rewriteHistoryRemoteImages(
  messages: SessionHistoryMessage[],
  host: string,
  sessionId: string,
): Promise<SessionHistoryMessage[]> {
  // Resolve sshTarget from config.hosts
  let sshTarget: SshTarget | undefined
  try {
    const { getConfig } = await import('./config-manager.js')
    const config = await getConfig()
    const hostDef = config.hosts?.[host]
    if (hostDef) {
      const hostname = hostDef.hostname ?? (hostDef as Record<string, unknown>).ssh as string | undefined
      if (hostname) {
        sshTarget = { hostname, user: hostDef.user, port: hostDef.port }
      }
    }
  } catch {
    log.session.warn('failed to resolve host config for history image rewrite', { host, sessionId })
  }

  if (!sshTarget) return messages

  const cache = new Map<string, string>()

  for (const msg of messages) {
    // Rewrite text content
    if (msg.text) {
      msg.text = rewriteRemoteImagePaths(msg.text, sshTarget, sessionId, cache)
    }
    // Rewrite tool results
    if (msg.tools) {
      for (const tool of msg.tools) {
        if (tool.result) {
          tool.result = rewriteRemoteImagePaths(tool.result, sshTarget, sessionId, cache)
        }
      }
    }
  }

  return messages
}
