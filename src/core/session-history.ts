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

import fsp from 'node:fs/promises';
import { log } from '../logging/index.js';
import {
  encodeProjectPath,
  findLocalJsonlPath,
  isSafeForProjectEncoding,
  readSessionJsonlContent,
  readSubagentContents,
  readSingleSubagentContent,
  readWorkflowManifest,
  readWorkflowSubagentContent,
  remoteJsonlPath,
} from './session-file-reader.js';
import { accumulateWorkflowProgress, sortedPhases, sortedAgents } from './workflow-progress.js';
import type { SessionBackgroundTasksPayload, WorkflowPhaseInfo, WorkflowAgentInfo } from './event-types.js';
import os from 'node:os';
import path from 'node:path';
import { findImagePaths, findRelativeImageNames } from '../providers/session-io.js';
import { REMOTE_IMAGES_DIR } from '../constants.js';

/** Cached homedir — avoids repeated syscall on each history request */
const LOCAL_HOME = os.homedir();

// ── Server-side parsed history cache (mtime-based, for completed/historical sessions) ──

interface ParsedHistoryCacheEntry {
  mtimeMs: number;
  messages: SessionHistoryMessage[];
}

const MAX_HISTORY_CACHE = 30;
const parsedHistoryCache = new Map<string, ParsedHistoryCacheEntry>();

/**
 * Resolved remote path cache — sessionId@host → full remote path of the JSONL
 * as it actually exists on the remote host. Populated after the first successful
 * `readSessionJsonlContent` for sessions whose cwd encoding is unsafe (> 200
 * chars, Claude Code hashes them and we can't replicate the hash). Lets the
 * mtime-stat fast path work for these sessions on subsequent reads.
 */
const remoteResolvedPaths = new Map<string, string>();
const MAX_RESOLVED_PATHS = 200;
function resolvedPathKey(sessionId: string, host: string): string { return `${sessionId}@${host}`; }
function getResolvedRemotePath(sessionId: string, host: string): string | undefined {
  return remoteResolvedPaths.get(resolvedPathKey(sessionId, host));
}
function setResolvedRemotePath(sessionId: string, host: string, fullPath: string): void {
  const key = resolvedPathKey(sessionId, host);
  remoteResolvedPaths.delete(key);
  remoteResolvedPaths.set(key, fullPath);
  if (remoteResolvedPaths.size > MAX_RESOLVED_PATHS) {
    const oldest = remoteResolvedPaths.keys().next().value;
    if (oldest) remoteResolvedPaths.delete(oldest);
  }
}

/** Compose cache key so local and remote entries for the same sessionId don't collide. */
function cacheKey(sessionId: string, host?: string): string {
  return host ? `${sessionId}@${host}` : sessionId;
}

function cacheGet(sessionId: string, host?: string): ParsedHistoryCacheEntry | undefined {
  return parsedHistoryCache.get(cacheKey(sessionId, host));
}

function cacheSet(sessionId: string, entry: ParsedHistoryCacheEntry, host?: string): void {
  const key = cacheKey(sessionId, host);
  parsedHistoryCache.delete(key);
  parsedHistoryCache.set(key, entry);
  if (parsedHistoryCache.size > MAX_HISTORY_CACHE) {
    const oldest = parsedHistoryCache.keys().next().value;
    if (oldest) parsedHistoryCache.delete(oldest);
  }
}

// ── Image file detection ──

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg)$/i;

/** Check if a file path looks like an image */
export function isImagePath(p: string): boolean {
  return IMAGE_EXT_RE.test(p);
}

/**
 * Extract the file path from a tool_use input block if it points to an image.
 * Checks common field names: file_path (most specific), then path, then filename.
 * Only matches Read/Write/Edit-style tools that have an explicit file path input.
 */
export function extractImageFilePathFromInput(input: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'path', 'filename']) {
    const val = input[key];
    if (typeof val === 'string' && val && isImagePath(val)) return val;
  }
  return undefined;
}

// Re-export for backward compatibility
export { encodeProjectPath };
export { findLocalJsonlPath as findSessionJsonlPath } from './session-file-reader.js';

export interface SessionHistoryTool {
  name: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  result?: string;
  planContent?: string;
  /** agentId extracted from Task/Agent tool_result — links to subagent JSONL */
  agentId?: string;
  /** Team name extracted from Agent tool input (for multi-agent teams) */
  teamName?: string;
  /** Team agent name extracted from Agent tool input */
  teamAgentName?: string;
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
  /** Walnut-generated message ID for deterministic dedup of optimistic user messages.
   *  Present on synthetic user events written by writeSyntheticUserEvent(). */
  walnutMessageId?: string;
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
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  parent_tool_use_id?: string | null;
  /** Walnut-generated message ID on synthetic user events (subtype='walnut-injected'). */
  walnutMessageId?: string;
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

/** Tool names whose child messages (identified by parent_tool_use_id) should be grouped. */
const GROUPABLE_TOOL_NAMES = new Set(['Task', 'Agent']);

/**
 * Group inline subagent children under their parent tool calls.
 * For Agent tools (Claude Code subagents), child messages live in the same JSONL
 * with parent_tool_use_id pointing to the parent tool_use block.
 * This function moves those children into tool.childMessages and removes them
 * from the flat result array.
 */
function groupInlineChildren(
  result: SessionHistoryMessage[],
  parentIds: (string | undefined)[],
): SessionHistoryMessage[] {
  // Build map: parentToolUseId → child result indices
  const childIndicesByParent = new Map<string, number[]>();
  for (let i = 0; i < result.length; i++) {
    const pid = parentIds[i];
    if (!pid) continue;
    const arr = childIndicesByParent.get(pid);
    if (arr) arr.push(i);
    else childIndicesByParent.set(pid, [i]);
  }
  if (childIndicesByParent.size === 0) return result;

  // Attach children to parent tools (Agent, Task, etc.)
  for (const msg of result) {
    if (!msg.tools) continue;
    for (const tool of msg.tools) {
      if (!tool.toolUseId || !GROUPABLE_TOOL_NAMES.has(tool.name)) continue;
      const childIndices = childIndicesByParent.get(tool.toolUseId);
      if (!childIndices) continue;
      // Don't overwrite childMessages already populated by readSubagentContents
      if (tool.childMessages && tool.childMessages.length > 0) continue;
      tool.childMessages = childIndices.map(i => result[i]);
    }
  }

  // Remove consumed children from the flat list
  const consumed = new Set<number>();
  for (const indices of childIndicesByParent.values()) {
    // Only remove if actually attached to a parent tool
    const parentToolUseId = parentIds[indices[0]];
    if (!parentToolUseId) continue;
    const isAttached = result.some(m =>
      m.tools?.some(t => t.toolUseId === parentToolUseId && t.childMessages && t.childMessages.length > 0)
    );
    if (isAttached) {
      for (const i of indices) consumed.add(i);
    }
  }
  if (consumed.size === 0) return result;
  return result.filter((_, i) => !consumed.has(i));
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
    } catch (err) {
      log.session.debug('failed to parse JSONL entry', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Filter to user/assistant message types and deduplicate by message.id
  // (assistant messages can span multiple JSONL lines sharing the same message.id)
  const messageMap = new Map<string, {
    role: string;
    timestamp: string;
    model?: string;
    usage?: { input_tokens: number; output_tokens: number };
    parentToolUseId?: string;
    walnutMessageId?: string;
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
      // Merge content blocks from duplicate lines (with deduplication).
      // Claude Code writes each content block as a separate JSONL line sharing
      // the same message.id. Daemon reconnects or stream replays can cause the
      // same line to appear multiple times. Without dedup, identical text blocks
      // get joined by '\n' producing repeated output (e.g. 4x the same sentence).
      if (raw.message.content) {
        const blocks = typeof raw.message.content === 'string'
          ? [{ type: 'text' as const, text: raw.message.content }]
          : raw.message.content;
        // Dedup strategy: text/thinking use content equality (no stable ID); tool_use uses block.id (UUID).
        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            const isDup = existing.contentBlocks.some(
              b => b.type === 'text' && b.text === block.text
            );
            if (isDup) continue;
          }
          if (block.type === 'thinking' && block.thinking) {
            const isDup = existing.contentBlocks.some(
              b => b.type === 'thinking' && b.thinking === block.thinking
            );
            if (isDup) continue;
          }
          // tool_use blocks: deduplicate by block.id
          if (block.type === 'tool_use' && block.id) {
            const isDup = existing.contentBlocks.some(
              b => b.type === 'tool_use' && b.id === block.id
            );
            if (isDup) continue;
          }
          existing.contentBlocks.push(block);
        }
      }
      if (raw.message.usage) {
        existing.usage = raw.message.usage;
      }
      // Inherit parent_tool_use_id from any line in the group
      if (raw.parent_tool_use_id && !existing.parentToolUseId) {
        existing.parentToolUseId = raw.parent_tool_use_id;
      }
    } else {
      messageMap.set(msgId, {
        role: raw.message.role,
        timestamp: raw.timestamp ?? new Date().toISOString(),
        model: raw.message.model,
        usage: raw.message.usage,
        parentToolUseId: raw.parent_tool_use_id ?? undefined,
        walnutMessageId: raw.walnutMessageId ?? undefined,
        contentBlocks: raw.message.content
          ? (typeof raw.message.content === 'string'
            ? [{ type: 'text' as const, text: raw.message.content }]
            : [...raw.message.content])
          : [],
      });
    }
  }

  // ── Skip synthetic walnut-injected user messages ──
  // writeSyntheticUserEvent() appends user events to the streams file for real-time display.
  // When the streams file is used as the history source (canonical unavailable), these
  // synthetic entries duplicate the canonical user entries already in the file (from Claude
  // stdout capture). Remove synthetic copies — the canonical entries are at the correct
  // chronological position; synthetic entries may be offset due to async append timing.
  for (const [key, msg] of messageMap) {
    if (msg.role === 'user' && msg.walnutMessageId) {
      messageMap.delete(key);
    }
  }

  // ── Build tool_use_id → tool_result text mapping ──
  // Scan all user messages for tool_result blocks and extract their text content.
  // This lets us associate tool results with their corresponding tool_use blocks.
  const toolResultMap = new Map<string, string>();
  // Track which tool_result IDs contained image content blocks (base64 skipped)
  const imageResultIds = new Set<string>();
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
          // Always extract text blocks (they may accompany image blocks in mixed results).
          // Image blocks are skipped — we use the tool input's file_path instead,
          // avoiding 130K+ base64 strings in the history pipeline.
          resultText = (nested as Array<{ type: string; text?: string }>)
            .filter(c => c.type === 'text' && c.text)
            .map(c => c.text!)
            .join('\n');
          // Track tool_result IDs that contained image blocks — the file path
          // from the tool input will be appended in the second pass.
          const hasImage = (nested as Array<{ type: string }>).some(c => c.type === 'image');
          if (hasImage && block.tool_use_id) {
            imageResultIds.add(block.tool_use_id);
          }
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

  // Parallel array tracking which parentToolUseId each result entry belongs to
  const resultParentIds: (string | undefined)[] = [];

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
        let toolResult = toolUseId ? toolResultMap.get(toolUseId) : undefined;

        // If the tool_result had image content blocks, append the file path from the
        // tool input so the frontend's findImagePaths() can detect and render it.
        // For remote sessions, rewriteHistoryRemoteImages() will SCP the file.
        if (toolUseId && imageResultIds.has(toolUseId) && block.input) {
          const imgPath = extractImageFilePathFromInput(block.input as Record<string, unknown>);
          if (imgPath) {
            toolResult = toolResult ? `${toolResult}\n${imgPath}` : imgPath;
          }
        }

        // Extract agentId from Task/Agent tool results.
        // Task: "agentId: XXX (for resuming...)" — hex agent ID
        // Agent (teams): "agent_id: name@team" — name@team format
        let agentId: string | undefined;
        let teamName: string | undefined;
        let teamAgentName: string | undefined;
        if (block.name === 'Task' && toolResult) {
          const matches = [...toolResult.matchAll(/agentId:\s*([a-f0-9]+)/g)];
          if (matches.length > 0) agentId = matches[matches.length - 1][1];
        } else if (block.name === 'Agent' && toolResult) {
          // Team Agent: result contains "agent_id: name@team"
          const agentMatch = toolResult.match(/agent_id:\s*(\S+)/);
          if (agentMatch) agentId = agentMatch[1];
          // Also extract team_name from tool input
          if (typeof block.input?.team_name === 'string') {
            teamName = block.input.team_name;
            teamAgentName = typeof block.input?.name === 'string' ? block.input.name : undefined;
          }
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
            ...(teamName ? { teamName } : {}),
            ...(teamAgentName ? { teamAgentName } : {}),
          });
        }
      } else if (block.type === 'thinking' && block.thinking) {
        thinking = (thinking ? thinking + '\n' : '') + block.thinking;
      }
    }

    const text = textParts.join('\n').trim();

    // Skip messages with no visible content (e.g. tool_result-only user entries,
    // empty heartbeat lines). These produce ghost "You" bubbles in the UI.
    if (!text && tools.length === 0 && !thinking) continue;

    // Skip assistant messages with no visible text and no tools.
    // These are typically abandoned API calls where Claude thought but never
    // produced a response before the call was retried with a new message ID.
    if (msg.role === 'assistant' && !text && tools.length === 0) continue;

    result.push({
      role: msg.role as 'user' | 'assistant',
      text,
      timestamp: msg.timestamp,
      ...(tools.length > 0 ? { tools } : {}),
      ...(thinking ? { thinking } : {}),
      ...(msg.model ? { model: msg.model } : {}),
      ...(msg.usage ? { usage: msg.usage } : {}),
      ...(msg.walnutMessageId ? { walnutMessageId: msg.walnutMessageId } : {}),
    });
    resultParentIds.push(msg.parentToolUseId);
  }

  // Group inline subagent children (e.g. Agent tool calls from Claude Code).
  // Unlike Task tools (which have separate JSONL files), Agent children are inline
  // in the same JSONL with parent_tool_use_id linking them to the parent tool_use.
  return groupInlineChildren(result, resultParentIds);
}

/**
 * Read a single subagent's history by agentId (for lazy-load on demand).
 * Returns parsed child messages, or empty array if not found.
 *
 * `workflow=true` scans the nested subagents/workflows/<runId>/ layout used by
 * the dynamic-workflow tool; otherwise the flat subagents/ layout (Task/Team).
 */
export async function readSingleSubagentHistory(
  sessionId: string,
  agentId: string,
  cwd?: string,
  host?: string,
  workflow?: boolean,
): Promise<SessionHistoryMessage[]> {
  const content = workflow
    ? (await readWorkflowSubagentContent(sessionId, agentId, cwd, host))
        ?? (await readSingleSubagentContent(sessionId, agentId, cwd, host)) // fall back to flat layout
    : await readSingleSubagentContent(sessionId, agentId, cwd, host);
  if (!content) return [];
  try {
    return parseSessionMessages(content);
  } catch (err) {
    log.session.debug('failed to parse single subagent JSONL', {
      sessionId, agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Reconstruct a session's dynamic-workflow progress panel from the on-disk run
 * manifest (workflows/wf_<runId>.json). Used to repopulate the panel on page
 * reload / after server restart, when the live in-memory ClaudeCodeSession state
 * is gone. Returns null when the session never ran a workflow.
 *
 * The manifest stores the full accumulated `workflowProgress[]` in the same
 * format as the live event stream, so we run it through the SAME shared
 * accumulator — the reconstructed payload is byte-for-byte what the live panel
 * would have shown at the end of the run.
 */
export async function reconstructWorkflowProgress(
  sessionId: string,
  cwd?: string,
  host?: string,
): Promise<SessionBackgroundTasksPayload | null> {
  const manifest = await readWorkflowManifest(sessionId, cwd, host);
  if (!manifest) return null;

  const phases = new Map<number, WorkflowPhaseInfo>();
  const agents = new Map<string, WorkflowAgentInfo>();
  accumulateWorkflowProgress(manifest.workflowProgress, phases, agents);

  // inFlight here is best-effort display state: derive it from the agents still
  // marked running rather than hardcoding 0. The manifest is normally written at
  // run-end (so this is 0), but if a reload ever catches a mid-run manifest this
  // reports honestly. Either way it's superseded by the next live snapshot, and
  // turn-boundary completion is driven by session_state_changed{idle}, NOT this.
  const agentList = sortedAgents(agents);
  const inFlight = agentList.filter(a => a.status === 'running').length;
  return {
    sessionId,
    workflowName: manifest.workflowName,
    inFlight,
    tasks: [],
    phases: sortedPhases(phases),
    agents: agentList,
    scriptSource: manifest.script,
    workflowDescription: manifest.summary,
  };
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
export interface ReadHistoryOptions {
  /** Skip reading subagent JSONL files (default: false). When true, Task tools retain agentId but childMessages stays undefined — frontend lazy-loads on demand. */
  skipSubagents?: boolean;
}

export async function readSessionHistory(sessionId: string, cwd?: string, host?: string, outputFile?: string, options?: ReadHistoryOptions): Promise<SessionHistoryMessage[]> {
  let messages: SessionHistoryMessage[] | null = null;

  // Server-side mtime cache: check if JSONL hasn't changed since last parse.
  // Primarily benefits completed/historical sessions viewed repeatedly.
  //
  // Local: fs.stat on the canonical path (cheap).
  // Remote: one fs.stat RPC to the daemon — ~50ms and avoids re-fetching the
  //   whole JSONL over the tunnel (seconds for large sessions).
  let mtimeMs: number | undefined;
  if (!host) {
    const localPath = await findLocalJsonlPath(sessionId, cwd);
    if (localPath) {
      try {
        const stat = await fsp.stat(localPath);
        mtimeMs = stat.mtimeMs;
        const cached = cacheGet(sessionId);
        if (cached && cached.mtimeMs === mtimeMs) {
          // Cache hit — return cached messages (skipSubagents is the common path now,
          // so cached messages don't include childMessages and no mutation concern)
          return cached.messages;
        }
      } catch {
        // stat failed — proceed with full read
      }
    }
  } else {
    // Remote session: stat the JSONL path and compare mtime against the cache.
    // Path resolution:
    //   1. If cwd is safe for our encoding (<=200 chars encoded), build the
    //      exact canonical path from cwd.
    //   2. Otherwise (cwd missing or hashed by Claude Code), use a previously
    //      resolved full path if we've discovered one via a prior full read.
    let statPath: string | undefined;
    if (cwd && isSafeForProjectEncoding(cwd)) {
      statPath = remoteJsonlPath(sessionId, cwd);
    } else {
      statPath = getResolvedRemotePath(sessionId, host);
    }
    if (statPath) {
      try {
        const { DaemonFileReader } = await import('./daemon-file-reader.js');
        const reader = new DaemonFileReader(host);
        const statResult = await reader.stat(statPath);
        if (statResult) {
          mtimeMs = statResult.mtimeMs;
          const cached = cacheGet(sessionId, host);
          if (cached && cached.mtimeMs === mtimeMs) {
            return cached.messages;
          }
        }
      } catch (err) {
        // stat failed (old daemon without fs.stat, or transport error) — skip
        // the cache and fall through to a full read. Not fatal.
        log.session.debug('remote fs.stat failed, skipping history cache', {
          sessionId, host,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const result = await readSessionJsonlContent(sessionId, cwd, host, outputFile);
  if (result) {
    // Remember the resolved remote path so the next read can use the mtime
    // fast-path even when cwd is unsafe for our canonical path encoding.
    if (host && result.resolvedRemotePath) {
      setResolvedRemotePath(sessionId, host, result.resolvedRemotePath);
    }
    try {
      messages = parseSessionMessages(result.content);

      // Diagnostic: detect user message ordering issues
      const userTextIndices: number[] = [];
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'user' && messages[i].text?.trim()) userTextIndices.push(i);
      }
      if (userTextIndices.length > 1) {
        const lastAsst = messages.reduce((max, m, i) => m.role === 'assistant' ? i : max, -1);
        const usersAfterLastAsst = userTextIndices.filter(i => i > lastAsst).length;
        if (usersAfterLastAsst > userTextIndices.length / 2) {
          log.session.warn('⚠️ user messages bunched at end of parsed history', {
            sessionId: sessionId.substring(0, 8),
            source: result.source,
            host: host ?? 'local',
            total: messages.length,
            userText: userTextIndices.length,
            lastAsstIdx: lastAsst,
            usersAfterLastAsst,
            userPositions: userTextIndices.slice(0, 20),
          });
        }
      }
    } catch (err) {
      log.session.warn('failed to parse session history', {
        sessionId, source: result.source,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!messages) return [];

  // Attach subagent child messages (works for both local and remote sessions).
  // When skipSubagents is true, Task tools retain agentId but childMessages stays
  // undefined — the frontend lazy-loads subagent content on demand.
  if (!options?.skipSubagents) {
    const hasTaskTools = messages.some(m => m.tools?.some(t => t.name === 'Task' && t.agentId));
    if (hasTaskTools) {
      const subagentMap = await readSubagentMessages(sessionId, cwd, host);
      attachSubagentMessages(messages, subagentMap);
    }
  }

  // Refresh plan content from disk (local sessions only).
  // The plan file may have been updated after the initial Write captured in the JSONL
  // (e.g., agent continued editing the plan). Replace ExitPlanMode planContent
  // with the latest disk version so the PlanCard shows current content on first load.
  if (!host) {
    let planFilePath: string | undefined;
    for (const msg of messages) {
      if (!msg.tools) continue;
      for (const tool of msg.tools) {
        if (tool.name === 'Write' && typeof tool.input?.file_path === 'string'
          && tool.input.file_path.includes('.claude/plans/')) {
          planFilePath = tool.input.file_path;
        }
      }
    }
    if (planFilePath) {
      try {
        const diskContent = await fsp.readFile(planFilePath, 'utf-8');
        if (diskContent) {
          for (const msg of messages) {
            if (!msg.tools) continue;
            for (const tool of msg.tools) {
              if (tool.name === 'ExitPlanMode' && tool.planContent) {
                tool.planContent = diskContent;
              }
            }
          }
        }
      } catch (err) {
        log.session.debug('failed to read plan file from disk', {
          planFilePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Only cache when skipSubagents — attachSubagentMessages mutates tool.childMessages
  // in place, so caching with children attached would share mutable state across consumers.
  if (mtimeMs !== undefined && options?.skipSubagents) {
    cacheSet(sessionId, { mtimeMs, messages }, host);
  }

  return messages;
}

/**
 * Format a source session's conversation history for injection into a forked session.
 * Returns a text summary suitable for `append-system-prompt`, truncated to tokenBudget.
 *
 * Each message is formatted as:
 *   [turn N] User: <text>
 *   [turn N] Assistant [tool1, tool2]: <text>
 */
export function formatForkHistory(messages: SessionHistoryMessage[], tokenBudget = 50_000): string {
  const CHARS_PER_TOKEN = 3.5;
  const charBudget = Math.floor(tokenBudget * CHARS_PER_TOKEN);
  const MAX_PER_MSG = 2000;

  const lines: string[] = [];
  let turn = 0;
  for (const msg of messages) {
    if (msg.role === 'user') turn++;
    const toolInfo = msg.tools?.length ? ` [${msg.tools.map(t => t.name).join(', ')}]` : '';
    const role = msg.role === 'user' ? 'User' : `Assistant${toolInfo}`;
    const text = msg.text.length > MAX_PER_MSG
      ? msg.text.slice(0, MAX_PER_MSG) + `... [${msg.text.length} chars total]`
      : msg.text;
    if (text.trim()) {
      lines.push(`[turn ${turn}] ${role}: ${text}`);
    }
  }

  const full = lines.join('\n\n');
  if (full.length <= charBudget) return full;

  // Tail-truncate: keep the most recent turns
  const truncated = full.slice(-charBudget);
  const firstNewline = truncated.indexOf('\n');
  const clean = firstNewline > 0 ? truncated.slice(firstNewline + 1) : truncated;
  return '[...earlier conversation omitted]\n\n' + clean;
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
  const localPath = await findLocalJsonlPath(sessionId, cwd);
  let content: string | undefined;

  if (localPath) {
    try {
      content = await fsp.readFile(localPath, 'utf-8');
    } catch (err) {
      log.session.debug('failed to read local JSONL for plan extraction', {
        localPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
      } catch (err) {
        log.session.debug('failed to parse JSONL line in plan extraction', {
          error: err instanceof Error ? err.message : String(err),
        });
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
  /** Full model string from the last init event (e.g. "global.anthropic.claude-opus-4-6-v1[1m]"). */
  model?: string;
  planFile?: string;
  planCompleted?: boolean;
  activity?: string;
  /** 'error' or 'agent_complete' if a result event was found. */
  workStatus?: string;
  /** Byte length of the JSONL content that was read during recovery.
   *  Used as fromOffset when attaching to remote daemons to skip stale replays. */
  jsonlByteLength?: number;
  /** True if the last TeamCreate/TeamDelete pair leaves the session in team mode. */
  teamActive?: boolean;
  /** Count of background tasks (dynamic workflows / subagents) still in flight per the
   *  replayed task_started/task_notification events — used to rebuild running vs idle
   *  after reconnect/restart so an intermediate `result` isn't mistaken for turn-over. */
  bgTasksInFlight?: number;
  /** Last observed CLI session_state_changed.state, when present in the stream. */
  cliSessionState?: 'running' | 'idle' | 'requires_action';
  /** Pending control_request that was never answered (no matching control_response).
   *  Happens when Walnut server restarts while Claude Code is waiting for permission. */
  pendingControlRequest?: {
    request_id: string;
    request: { subtype: string; tool_name?: string; input?: Record<string, unknown>; tool_use_id?: string; decision_reason?: string };
  };
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
  const localPath = await findLocalJsonlPath(sessionId, cwd);
  let content: string | undefined;

  if (localPath) {
    try {
      content = await fsp.readFile(localPath, 'utf-8');
    } catch (err) {
      log.session.debug('failed to read local JSONL for state recovery', {
        localPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // If no local content and host provided, try remote
  if (!content && host) {
    const result = await readSessionJsonlContent(sessionId, cwd, host);
    if (result) content = result.content;
  }

  if (!content) return null;

  try {
    const lines = content.split('\n').filter(Boolean);

    const state: RecoveredSessionState = {
      jsonlByteLength: Buffer.byteLength(content, 'utf-8'),
    };

    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        log.session.debug('failed to parse JSONL line in state recovery', {
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const type = parsed.type as string | undefined;

      // ── model: extract from system init events only ──
      // Init events have the full model ID (e.g. "global.anthropic.claude-opus-4-6-v1[1m]").
      // NEVER use assistant message model — subagents use different models (e.g. Haiku).
      // Multiple init events = multiple --resume cycles. Prefer the version with [1m]
      // suffix — later resumes may have lost it due to the processNext default bug.
      // If no [1m] version exists, use the last init event's model as fallback.
      if (type === 'system' && parsed.subtype === 'init' && typeof parsed.model === 'string') {
        // De-duplicate [1m][1m] → [1m] from old resume bug
        const initModel = (parsed.model as string).replace(/(\[1m\])+$/, '[1m]');
        if (initModel.endsWith('[1m]')) {
          state.model = initModel;  // [1m] found — lock it in
        } else if (!state.model?.endsWith('[1m]')) {
          state.model = initModel;  // no [1m] yet — use this as fallback
        }
        // else: already have a [1m] version, don't overwrite with non-[1m]
      }

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

      if (type === 'user' && parsed.subtype !== 'walnut-injected') {
        // A user message after a result means the session was resumed —
        // clear workStatus so we don't incorrectly report agent_complete.
        // Skip synthetic walnut-injected events (written by Walnut for dedup, not real turns).
        if (state.workStatus) {
          state.workStatus = undefined;
          state.activity = undefined;
        }
      }

      // ── Background-task lifecycle (dynamic workflows / subagents) ──
      // Rebuild the in-flight count so we can tell, after reconnect/restart, whether
      // a replayed `result` is a real turn-over or just an intermediate result emitted
      // while background work continues.
      if (type === 'system') {
        const subtype = (parsed as Record<string, unknown>).subtype as string | undefined;
        if (subtype === 'task_started') {
          state.bgTasksInFlight = (state.bgTasksInFlight ?? 0) + 1;
        } else if (subtype === 'task_notification') {
          state.bgTasksInFlight = Math.max(0, (state.bgTasksInFlight ?? 0) - 1);
        } else if (subtype === 'session_state_changed') {
          const s = (parsed as Record<string, unknown>).state as
            | 'running' | 'idle' | 'requires_action' | undefined;
          state.cliSessionState = s;
          // idle is the turn-over TRIGGER, not turn-over itself. POC-verified (see memory
          // claude-code-session-state-semantics): the CLI emits idle ~20×/run — between
          // every sub-agent / phase — because its idle-wait loop excludes
          // in_process_teammate tasks. So a mid-workflow restart's JSONL almost always
          // contains idle events while tasks are still in flight. The turn is over only
          // when idle coincides with a drained counter. The OLD code unconditionally set
          // agent_complete + zeroed the counter on ANY idle, which marked a still-running
          // workflow complete on restart (defeating the recovery this whole block exists
          // for). Gate on the counter; NEVER hard-reset it (task_notification owns that).
          if (s === 'idle' && (state.bgTasksInFlight ?? 0) === 0) { state.workStatus = 'agent_complete'; }
          else if (s === 'running') { state.workStatus = undefined; }
        }
      }

      // result events indicate turn completion — BUT a dynamic-workflow turn emits one
      // result per background subagent completion, and the main turn's result lands
      // while subagents still run. So a `result` is only a real turn-over when no
      // background work remains AND the CLI hasn't told us it's still running. When
      // session_state events are present, they own workStatus (handled above); we only
      // fall back to result-implies-complete when bg work is quiescent.
      if (type === 'result') {
        const isErr = (parsed as Record<string, unknown>).is_error;
        if (isErr) {
          state.workStatus = 'error';
        } else if ((state.bgTasksInFlight ?? 0) === 0 && state.cliSessionState !== 'running') {
          state.workStatus = 'agent_complete';
        }
        // else: intermediate result during live background work — leave workStatus as-is.
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

          // ── TeamCreate / TeamDelete: team mode detection ──
          // Mirrors live detection in claude-code-session.ts (handleStreamEvent).
          // Needed so _teamActive survives server restart — without this, the
          // dispatcher's teamActive guard has no signal and every intermediate
          // team result triggers triage.
          if (name === 'TeamCreate') {
            state.teamActive = true;
          }
          if (name === 'TeamDelete') {
            state.teamActive = false;
          }
        }
      }

      // ── control_request / control_response: detect orphaned permission requests ──
      // Claude Code emits control_request when it needs permission for a tool.
      // Walnut responds with control_response via FIFO. If the server crashes/restarts
      // between these two events, Claude Code's stdin read loop freezes waiting for
      // control_response — it ignores all other FIFO input (user messages pile up
      // unread). No internal timeout exists, so the session hangs permanently.
      // Track the last unmatched control_request so attachToExisting() can recover it.
      if (type === 'control_request') {
        const req = parsed as { request_id?: string; request?: Record<string, unknown> };
        if (req.request_id && req.request) {
          state.pendingControlRequest = {
            request_id: req.request_id,
            request: req.request as NonNullable<RecoveredSessionState['pendingControlRequest']>['request'],
          };
        }
      }
      if (type === 'control_response') {
        // A control_response means the pending request was answered — clear it.
        // Match by request_id to avoid clearing the wrong request in edge cases
        // (e.g., rapid sequential control_request events).
        const resp = parsed as { response?: { request_id?: string } };
        const respId = resp.response?.request_id;
        if (respId && state.pendingControlRequest?.request_id === respId) {
          state.pendingControlRequest = undefined;
        } else if (!respId) {
          // Fallback: if no request_id in response, clear unconditionally
          state.pendingControlRequest = undefined;
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
 * Download a single file from a remote host via the daemon's fs.read command.
 * Returns true on success, false on failure (graceful degradation).
 */
async function downloadImageViaDaemon(host: string, remotePath: string, localPath: string): Promise<boolean> {
  try {
    const { getDaemonConnection } = await import('../providers/daemon-connection.js')
    const { getConfig } = await import('./config-manager.js')
    const config = await getConfig()
    const hostDef = config.hosts?.[host]
    if (!hostDef?.hostname) return false
    const sshTarget = { hostname: hostDef.hostname, user: hostDef.user, port: hostDef.port }
    const conn = await getDaemonConnection(host, sshTarget)
    const result = await conn.send('fs.read', { path: remotePath, encoding: 'base64' })
    if (!result.ok || !result.data) return false
    const fs = await import('node:fs')
    fs.mkdirSync(path.dirname(localPath), { recursive: true })
    fs.writeFileSync(localPath, Buffer.from(result.data as string, 'base64'))
    return true
  } catch { return false }
}

/**
 * Rewrite remote image paths in session history messages to local paths.
 * Used when replaying history for a remote session — downloads images via
 * the daemon (not SCP) and rewrites paths so the UI can render them.
 */
export async function rewriteHistoryRemoteImages(
  messages: SessionHistoryMessage[],
  host: string,
  sessionId: string,
  cwd?: string,
): Promise<SessionHistoryMessage[]> {
  const cache = new Map<string, string>()
  const fs = await import('node:fs')

  // Pre-scan: build filename → absolute path hints from tool inputs/results.
  // Tool inputs (e.g. Bash `cp` commands, file paths) contain full absolute paths
  // that are more accurate than CWD-based resolution for relative filenames.
  const filePathHints = new Map<string, string[]>()
  const isUsefulHint = (p: string) =>
    !p.startsWith(LOCAL_HOME) &&        // skip local filesystem paths
    p.lastIndexOf('/') > 0              // require ≥2 path components
  const addHint = (p: string) => {
    const bn = path.basename(p)
    const arr = filePathHints.get(bn)
    if (arr) { if (!arr.includes(p)) arr.push(p) }
    else filePathHints.set(bn, [p])
  }
  for (const msg of messages) {
    if (!msg.tools) continue
    for (const tool of msg.tools) {
      const inputStr = typeof tool.input === 'string'
        ? tool.input
        : (tool.input ? JSON.stringify(tool.input) : '')
      for (const p of findImagePaths(inputStr)) {
        if (isUsefulHint(p)) addHint(p)
      }
      if (tool.result) {
        for (const p of findImagePaths(tool.result)) {
          if (isUsefulHint(p)) addHint(p)
        }
      }
    }
  }

  /**
   * Rewrite image paths in a text string: detect remote paths, map to local,
   * and fire-and-forget daemon downloads for images not yet on disk.
   */
  const rewriteText = (text: string): string => {
    let rewritten = text

    // Pass 1: absolute remote paths
    const remotePaths = findImagePaths(text)
    for (const remotePath of remotePaths) {
      // Skip local paths
      if (remotePath.startsWith(LOCAL_HOME) || remotePath.startsWith(REMOTE_IMAGES_DIR)) continue

      let localPath = cache.get(remotePath)
      if (!localPath) {
        localPath = path.join(REMOTE_IMAGES_DIR, sessionId, path.basename(remotePath))
        cache.set(remotePath, localPath)

        if (!fs.existsSync(localPath)) {
          downloadImageViaDaemon(host, remotePath, localPath).catch(() => {})
        }
      }
      rewritten = rewritten.split(remotePath).join(localPath)
    }

    // Pass 2: relative image filenames resolved against remote CWD
    if (cwd) {
      const relNames = findRelativeImageNames(rewritten)
      for (const relName of relNames) {
        const basename = path.basename(relName)
        const hintPaths = filePathHints.get(basename) ?? []
        const cwdPath = `${cwd.replace(/\/$/, '')}/${relName}`
        const tmpPath = `/tmp/${basename}`
        const candidates = [...hintPaths]
        if (!candidates.includes(cwdPath)) candidates.push(cwdPath)
        if (!candidates.includes(tmpPath)) candidates.push(tmpPath)

        if (candidates.some(c => cache.has(c))) continue

        let localPath = cache.get(`rel:${relName}`)
        if (!localPath) {
          localPath = path.join(REMOTE_IMAGES_DIR, sessionId, basename)
          cache.set(`rel:${relName}`, localPath)

          if (!fs.existsSync(localPath)) {
            const lp = localPath
            ;(async () => {
              for (const candidate of candidates) {
                const ok = await downloadImageViaDaemon(host, candidate, lp)
                if (ok) return
              }
            })().catch(() => {})
          }
        }
        const escaped = relName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const nameRe = new RegExp(`(?<=^|[\\s"'\`=:(])${escaped}(?=[\\s"'\`),;\\]}]|$)`, 'g')
        rewritten = rewritten.replace(nameRe, () => localPath!)
      }
    }

    return rewritten
  }

  for (const msg of messages) {
    if (msg.text) {
      msg.text = rewriteText(msg.text)
    }
    if (msg.tools) {
      for (const tool of msg.tools) {
        if (tool.result) {
          tool.result = rewriteText(tool.result)
        }
      }
    }
  }

  return messages
}
