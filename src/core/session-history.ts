/**
 * Session History Reader — reads Claude Code's JSONL conversation files.
 *
 * Claude Code stores session history at:
 *   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 *
 * Path encoding: /Users/foo/bar → -Users-foo-bar (replace / with -)
 */

import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_HOME, SESSION_STREAMS_DIR } from '../constants.js';
import { getConfig } from './config-manager.js';
import { log } from '../logging/index.js';

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

/**
 * Encode a working directory path the way Claude Code does.
 * /Users/foo/bar → -Users-foo-bar
 */
export function encodeProjectPath(cwd: string): string {
  return cwd.replaceAll('/', '-');
}

/**
 * Find the local streaming capture file in SESSION_STREAMS_DIR for a session.
 * These files are created when sessions are run (local or remote via SSH stdout pipe).
 */
function findLocalStreamPath(sessionId: string): string | null {
  try {
    const files = fs.readdirSync(SESSION_STREAMS_DIR);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = path.join(SESSION_STREAMS_DIR, file);
      try {
        const firstLine = fs.readFileSync(filePath, 'utf-8').split('\n')[0];
        if (firstLine) {
          const parsed = JSON.parse(firstLine);
          if (parsed.sessionId === sessionId || parsed.session_id === sessionId) {
            return filePath;
          }
        }
      } catch {
        // Skip unparseable files
      }
    }
  } catch {
    // SESSION_STREAMS_DIR doesn't exist
  }
  return null;
}

/**
 * Build the remote JSONL path on a remote host.
 * Claude Code stores sessions at ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 */
function buildRemoteJsonlPath(sessionId: string, cwd?: string): string {
  if (cwd) {
    const encoded = encodeProjectPath(cwd);
    return `~/.claude/projects/${encoded}/${sessionId}.jsonl`;
  }
  // Without cwd, use a glob pattern to find the file
  return `~/.claude/projects/*/${sessionId}.jsonl`;
}

/**
 * Read session JSONL content from a remote host via SSH.
 * Returns the raw JSONL content string, or null on failure.
 */
async function readRemoteJsonlContent(host: string, sessionId: string, cwd?: string): Promise<string | null> {
  try {
    const config = await getConfig();
    const hostConfig = config.hosts?.[host];
    if (!hostConfig) {
      log.session.warn('SSH fallback: unknown host', { host, sessionId });
      return null;
    }

    const target = hostConfig.user ? `${hostConfig.user}@${hostConfig.hostname}` : hostConfig.hostname;
    const sshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no'];
    if (hostConfig.port) {
      sshArgs.push('-p', String(hostConfig.port));
    }

    const remotePath = buildRemoteJsonlPath(sessionId, cwd);
    const useGlob = !cwd;

    // When cwd is unknown, use a glob to find the file on the remote
    const remoteCmd = useGlob
      ? `for f in ${remotePath}; do [ -f "$f" ] && cat "$f" && exit 0; done; exit 1`
      : `cat '${remotePath}'`;

    const { execSync } = await import('node:child_process');
    const content = execSync(
      `ssh ${sshArgs.join(' ')} ${target} "${remoteCmd}"`,
      { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return content || null;
  } catch (err) {
    log.session.debug('SSH fallback failed', {
      host,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Find the JSONL file for a session.
 * If cwd provided, check the exact encoded path.
 * Fallback: search all project dirs for the session ID.
 */
export function findSessionJsonlPath(sessionId: string, cwd?: string): string | null {
  const projectsDir = path.join(CLAUDE_HOME, 'projects');

  if (cwd) {
    const encoded = encodeProjectPath(cwd);
    const filePath = path.join(projectsDir, encoded, `${sessionId}.jsonl`);
    if (fs.existsSync(filePath)) return filePath;
  }

  // Fallback: search all project directories
  try {
    const dirs = fs.readdirSync(projectsDir);
    for (const dir of dirs) {
      const filePath = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(filePath)) return filePath;
    }
  } catch {
    // projects dir doesn't exist
  }

  return null;
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
 * Core parsing logic: parse JSONL content and return deduplicated SessionHistoryMessage[].
 * Accepts either a file path (reads from disk) or raw content string (for SSH fallback).
 */
function parseSessionMessages(filePathOrContent: string, isRawContent = false): SessionHistoryMessage[] {
  const content = isRawContent ? filePathOrContent : fs.readFileSync(filePathOrContent, 'utf-8');
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
    /** parent_tool_use_id from stream capture — non-null for subagent child events */
    parentToolUseId?: string;
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
    const parentToolUseId = raw.parent_tool_use_id ?? undefined;
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
      // Capture parentToolUseId if not already set
      if (parentToolUseId && !existing.parentToolUseId) {
        existing.parentToolUseId = parentToolUseId;
      }
    } else {
      messageMap.set(msgId, {
        role: raw.message.role,
        timestamp: raw.timestamp ?? new Date().toISOString(),
        model: raw.message.model,
        usage: raw.message.usage,
        parentToolUseId,
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
      // Internal: track parentToolUseId for post-processing (stripped before return)
      ...(msg.parentToolUseId ? { _parentToolUseId: msg.parentToolUseId } as Record<string, unknown> : {}),
    });
  }

  // ── Post-processing: group child messages by parentToolUseId ──
  // Stream capture JSONL includes parent_tool_use_id on every child event.
  // Separate child messages and attach them to their parent Task tool_use.
  const childMessagesByParent = new Map<string, SessionHistoryMessage[]>();
  const parentMessages: SessionHistoryMessage[] = [];

  for (const msg of result) {
    const ptid = (msg as unknown as Record<string, unknown>)._parentToolUseId as string | undefined;
    // Clean up internal field
    delete (msg as unknown as Record<string, unknown>)._parentToolUseId;
    if (ptid) {
      const arr = childMessagesByParent.get(ptid);
      if (arr) arr.push(msg);
      else childMessagesByParent.set(ptid, [msg]);
    } else {
      parentMessages.push(msg);
    }
  }

  // Attach child messages to their parent Task tool_use blocks
  if (childMessagesByParent.size > 0) {
    for (const msg of parentMessages) {
      if (!msg.tools) continue;
      for (const tool of msg.tools) {
        if (tool.name === 'Task' && tool.toolUseId && childMessagesByParent.has(tool.toolUseId)) {
          // Only set childMessages if not already populated (subagent JSONL takes precedence)
          if (!tool.childMessages) {
            tool.childMessages = childMessagesByParent.get(tool.toolUseId);
          }
        }
      }
    }
  }

  return childMessagesByParent.size > 0 ? parentMessages : result;
}

/**
 * Read subagent JSONL files for a session.
 * Claude Code stores each Task subagent's full conversation at:
 *   ~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<agentId>.jsonl
 *
 * Returns a Map<agentId, SessionHistoryMessage[]> with parsed child messages.
 */
function readSubagentMessages(sessionId: string, cwd?: string): Map<string, SessionHistoryMessage[]> {
  const result = new Map<string, SessionHistoryMessage[]>();
  const projectsDir = path.join(CLAUDE_HOME, 'projects');

  // Find the session directory (which contains the subagents/ folder)
  const candidates: string[] = [];
  if (cwd) {
    const encoded = encodeProjectPath(cwd);
    candidates.push(path.join(projectsDir, encoded, sessionId));
  }
  // Fallback: search all project directories
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      const candidate = path.join(projectsDir, dir, sessionId);
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  } catch { /* projects dir doesn't exist */ }

  for (const sessionDir of candidates) {
    const subagentsDir = path.join(sessionDir, 'subagents');
    if (!fs.existsSync(subagentsDir)) continue;

    try {
      const files = fs.readdirSync(subagentsDir);
      for (const file of files) {
        if (!file.startsWith('agent-') || !file.endsWith('.jsonl')) continue;
        // Extract agentId from filename: agent-a05f354d2ba698034.jsonl → a05f354d2ba698034
        const agentId = file.slice('agent-'.length, -'.jsonl'.length);
        const filePath = path.join(subagentsDir, file);
        try {
          const messages = parseSessionMessages(filePath);
          if (messages.length > 0) {
            result.set(agentId, messages);
          }
        } catch (err) {
          log.session.debug('failed to parse subagent JSONL', {
            sessionId, agentId, filePath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      log.session.debug('failed to read subagents dir', {
        sessionId, subagentsDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Found the session dir with subagents — no need to check more candidates
    if (result.size > 0) break;
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
 * When `host` is provided and local files aren't found, falls back to reading
 * from the remote machine via SSH. Local streaming files (SESSION_STREAMS_DIR)
 * are checked first since they're immediately available.
 *
 * When `outputFile` is provided (from the session record), it is tried as a
 * direct fallback before SSH — useful for sessions that died before the JSONL
 * was renamed to the canonical path (e.g. resume-failure phantom sessions).
 */
export async function readSessionHistory(sessionId: string, cwd?: string, host?: string, outputFile?: string): Promise<SessionHistoryMessage[]> {
  let messages: SessionHistoryMessage[] | null = null;

  // 1. Try local canonical path (~/.claude/projects/...)
  const filePath = findSessionJsonlPath(sessionId, cwd);
  if (filePath) {
    try {
      messages = parseSessionMessages(filePath);
    } catch (err) {
      log.session.warn('failed to read session history', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall through to other strategies
    }
  }

  // 2. Try local streaming capture (SESSION_STREAMS_DIR — available for both local and SSH sessions)
  if (!messages) {
    const streamPath = findLocalStreamPath(sessionId);
    if (streamPath) {
      try {
        messages = parseSessionMessages(streamPath);
      } catch (err) {
        log.session.warn('failed to read session stream file', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // 2.5 Try the direct outputFile path from the session record — handles cases where
  // the tmp file was never renamed to the canonical path (e.g. session died before init).
  if (!messages && outputFile) {
    try {
      if (fs.existsSync(outputFile)) {
        messages = parseSessionMessages(outputFile);
      }
    } catch (err) {
      log.session.warn('failed to read session outputFile', {
        sessionId,
        outputFile,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 3. SSH fallback: read from remote host when host is provided
  if (!messages && host) {
    const remoteContent = await readRemoteJsonlContent(host, sessionId, cwd);
    if (remoteContent) {
      try {
        messages = parseSessionMessages(remoteContent, true);
      } catch (err) {
        log.session.warn('failed to parse remote session history', {
          sessionId,
          host,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (!messages) return [];

  // 4. Check for Task tool_use blocks with agentIds — attach subagent child messages
  const hasTaskTools = messages.some(m => m.tools?.some(t => t.name === 'Task' && t.agentId));
  if (hasTaskTools) {
    const subagentMap = readSubagentMessages(sessionId, cwd);
    attachSubagentMessages(messages, subagentMap);
  }

  return messages;
}

/**
 * Extract only the plan content from a session's JSONL file.
 * Scans for Write→~/.claude/plans/ and ExitPlanMode tool_use blocks
 * without building the full message array — lightweight fast path.
 */
export function extractPlanContent(sessionId: string, cwd?: string): string | null {
  const filePath = findSessionJsonlPath(sessionId, cwd);
  if (!filePath) return null;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
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
 * Scans forward through the file, keeping only the LAST value of each field.
 */
export function recoverStateFromJsonl(sessionId: string, cwd?: string): RecoveredSessionState | null {
  const filePath = findSessionJsonlPath(sessionId, cwd);
  if (!filePath) return null;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
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
          // Empirically verified across 5+ test sessions — see session a5742374,
          // 8a9962d9, e89fc530 where canonical JSONL has zero permissionMode=plan.
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
