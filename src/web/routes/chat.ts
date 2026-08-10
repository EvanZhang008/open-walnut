/**
 * Chat route — bridges WebSocket RPC to the agent loop.
 *
 * Server is the source of truth for conversation history.
 * Client sends only { message }, server loads history from ChatHistoryManager,
 * runs the agent loop, and persists the new turn to disk.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { WebSocket } from 'ws'
import type { MessageParam } from '../../agent/model.js'
import type { DisplayMessageBlock } from '../../core/types.js'
import type { CompactionResult } from '../../core/chat-history.js'
import { MEMORY_FLUSH_MESSAGE } from '../../core/chat-history.js'
import { registerMethod, broadcastEvent } from '../ws/handler.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { usageTracker } from '../../core/usage/index.js'
import * as chatHistory from '../../core/chat-history.js'
import { getActiveConversationId } from '../../core/conversations.js'
import { drainPendingCronNotifications } from '../server.js'
import { getTask, appendConversationLog } from '../../core/task-manager.js'
import { getProjectMemory } from '../../core/project-memory.js'
import { resolveProjectSkillDir } from '../../core/overview-log.js'
import { getSessionByClaudeId } from '../../core/session-tracker.js'
import { resolvePayloadImages, buildImageAnnotation } from './images.js'
import type { ImagePayload, ImageRef } from './images.js'
import { truncateToTokenBudget } from '../../utils/token-truncate.js'
import { log } from '../../logging/index.js'
import { validateAgentId, validateConversationId, GLOBAL_SKILLS_DIR } from '../../constants.js'
import { enqueueAgentTurn, recordLastTurnTokens } from '../agent-turn-queue.js'
import { triggerBackgroundCompaction } from '../background-compaction.js'
import {
  shouldUpdateWorkingMemory,
  executeWorkingMemoryUpdate,
  trackToolCall as trackWmToolCall,
} from '../../agent/working-memory-updater.js'
import {
  hasPendingQuestion,
  submitTextAnswer,
  submitAnswers,
  cancelQuestion,
} from '../../core/agent-question.js'

/**
 * Track usage for compaction-related LLM calls (both summarizer and memory flusher).
 */
function trackCompactionUsage(usage: { model?: string; input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }): void {
  try {
    usageTracker.record({
      source: 'compaction',
      model: usage.model ?? 'unknown',
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
    })
  } catch { /* non-critical */ }
}

/**
 * Create summarizer and memoryFlusher callbacks for compaction.
 * Shared by the WebSocket chat handler and the REST /compact endpoint.
 */
export async function createCompactionCallbacks(options?: { trackUsage?: boolean }): Promise<{
  summarizer: (instruction: string, history: MessageParam[]) => Promise<string>
  memoryFlusher: (messages: MessageParam[]) => Promise<void>
}> {
  const { runAgentLoop } = await import('../../agent/loop.js')
  const onUsage = options?.trackUsage ? trackCompactionUsage : undefined

  // Summarizer: receives full message history as MessageParam[] so the Bedrock
  // cache prefix (system + tools + messages) matches the main chat — maximizing
  // cache-read hits instead of paying cache-write for serialized text.
  //
  // Reference max_tokens for compaction summaries:
  // - Claude Code CLI: 20,000 (hardcoded in binary, thinking disabled)
  // - Moltbot: 13,107–16,000 (0.8 × reserveTokens; range because reserveTokens
  //   defaults to 16,384 from SDK but moltbot overrides the floor to 20,000 via
  //   DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR in pi-settings.ts)
  const summarizer = async (instruction: string, history: MessageParam[]) => {
    const result = await runAgentLoop(instruction, history, {
      onTextDelta: () => {},
      ...(onUsage && { onUsage }),
    }, { source: 'compaction-summarizer', modelConfig: { maxTokens: 20_000 } })
    return result.response
  }

  // Memory flusher: uses the DEFAULT full tool set (no custom tools override).
  // Previously this used a slim 2-tool set (memory + search only), which saved ~6K
  // tokens of tool schemas BUT broke the Bedrock prompt cache prefix. The main chat's
  // cached prefix is [system + 39 tools + messages]. When the flusher changed to 2 tools,
  // the entire 140K of messages became uncached (cache-write instead of cache-read),
  // making the first round ~5x slower. Keeping the full tool set preserves cache reuse.
  // The MEMORY_FLUSH_MESSAGE already instructs the agent to only use `memory`.
  const memoryFlusher = async (messages: MessageParam[]) => {
    await runAgentLoop(MEMORY_FLUSH_MESSAGE, messages, {
      onTextDelta: () => {},
      ...(onUsage && { onUsage }),
    }, { source: 'compaction-flush' })
  }

  return { summarizer, memoryFlusher }
}

interface TaskContext {
  id: string
  title: string
  project?: string
  status?: string
  phase?: string
  priority?: string
  starred?: boolean
  start_date?: string
  due_date?: string
  source?: string
  description?: string
  summary?: string
  note?: string
  conversation_log?: string
  created_at?: string
  plan_session_id?: string
  plan_session_status?: { process_status: string; activity?: string }
  exec_session_id?: string
  exec_session_status?: { process_status: string; activity?: string }
}

interface ChatPayload {
  message: string
  taskContext?: TaskContext
  /** Inline base64 — REST callers only; too big for a WS frame (see ImageRef). */
  images?: ImagePayload[]
  /** Filenames from POST /api/images/upload — the WS-safe attachment path. */
  imageRefs?: ImageRef[]
  source?: string
  mode?: 'execution' | 'plan'
  planModeFirst?: boolean
  /** Signal that plan mode was just deactivated (plan → execution transition). */
  planModeOff?: boolean
  /** Console agent ID — defaults to 'general'. */
  agentId?: string
  /** Conversation ID — defaults to the agent's active conversation. */
  conversationId?: string
}

// ── Plan Mode prompt injection ──
// Pure prompt control for plan mode — no tool filtering, just instruction injection.

const PLAN_MODE_FULL_INSTRUCTION = `[PLAN MODE]
Plan mode is active. The user indicated that they do not want you to execute yet — you MUST NOT create or update tasks, start or send to sessions, write or edit files, run shell commands, or otherwise make any changes to the system. This supersedes any other instructions you have received.

You may freely use read-only tools: query tasks, read files, search memory, browse the web, analyze images.

Your role in plan mode:
- COMMUNICATE — discuss ideas, ask clarifying questions, explore options with the user.
- Understand the user's intent fully before proposing solutions.
- When proposing a plan, be specific about what you would do, but do NOT execute it.
- If you are unsure about something, ask the user rather than making assumptions.

The user will switch to Execution mode when they are ready for you to act.
[/PLAN MODE]`

const PLAN_MODE_REMINDER = '[Reminder: Plan mode is still active — discuss and explore only, do not execute or make changes.]'

const EXECUTION_MODE_MESSAGE = `[EXECUTION MODE] Plan mode has been deactivated. You may now execute changes and take actions. Previous plan-mode restrictions no longer apply.`

/**
 * Build a human-readable task context prefix for the agent.
 * Returns empty string if taskContext is missing or malformed.
 */
export function buildTaskContextPrefix(ctx: TaskContext | null | undefined): string {
  if (!ctx || typeof ctx.id !== 'string') return ''

  const lines: string[] = [
    '[Task Context — The user has selected this task in the UI. Their message below is about this task. Answer in the context of this task.]',
  ]
  lines.push(`ID: ${ctx.id}`)
  lines.push(`Title: ${ctx.title}`)
  if (ctx.phase) lines.push(`Phase: ${ctx.phase}`)
  if (ctx.status) lines.push(`Status: ${ctx.status}`)
  if (ctx.priority && ctx.priority !== 'none') lines.push(`Priority: ${ctx.priority}`)
  if (ctx.starred) lines.push(`Starred: yes`)
  lines.push(`Project: ${ctx.project || 'Inbox'}`)
  if (ctx.source) lines.push(`Source: ${ctx.source}`)
  if (ctx.start_date) lines.push(`Start: ${ctx.start_date}`)
  if (ctx.due_date) lines.push(`Due: ${ctx.due_date}`)
  if (ctx.created_at) lines.push(`Created: ${ctx.created_at}`)

  if (ctx.description) {
    const truncated = ctx.description.length > 300 ? ctx.description.slice(0, 300) + ' [truncated]' : ctx.description
    lines.push(`Description: ${truncated}`)
  }

  if (ctx.summary) {
    const truncated = ctx.summary.length > 200 ? ctx.summary.slice(0, 200) + ' [truncated]' : ctx.summary
    lines.push(`Summary: ${truncated}`)
  }

  if (ctx.note) {
    const truncated = ctx.note.length > 500 ? ctx.note.slice(0, 500) + ' [truncated]' : ctx.note
    lines.push(`Note: ${truncated}`)
  }

  if (ctx.conversation_log) {
    // Tail-truncate: keep the most recent entries (end of the string)
    // Snap to the nearest entry heading (### ) to avoid garbled output
    let truncated: string
    if (ctx.conversation_log.length <= 400) {
      truncated = ctx.conversation_log
    } else {
      const raw = ctx.conversation_log.slice(ctx.conversation_log.length - 400)
      const headingIdx = raw.indexOf('### ')
      truncated = '[older entries omitted]\n' + (headingIdx >= 0 ? raw.slice(headingIdx) : raw).trim()
    }
    lines.push(`Conversation Log (recent):\n${truncated}`)
  }

  // Session slots — show IDs + status so the agent doesn't need extra get_session calls
  if (ctx.plan_session_id) {
    const ss = ctx.plan_session_status
    const parts = ss ? [ss.process_status, ...(ss.activity ? [ss.activity] : [])].join(', ') : ''
    lines.push(`Plan session: ${ctx.plan_session_id}${parts ? ` (${parts})` : ''}`)
  }
  if (ctx.exec_session_id) {
    const ss = ctx.exec_session_status
    const parts = ss ? [ss.process_status, ...(ss.activity ? [ss.activity] : [])].join(', ') : ''
    lines.push(`Exec session: ${ctx.exec_session_id}${parts ? ` (${parts})` : ''}`)
  }

  lines.push('[/Task Context]')
  return lines.join('\n') + '\n\n'
}

// ── Token budgets for enriched task context ──
const ENRICHED_BUDGETS = {
  description: 1000,
  summary: 500,
  note: 2000,
  projectMemory: 2000,
  conversationLog: 500,
} as const;

/** SHA256 hash of a string. Returns empty string for empty/null input. */
function contentHash(text: string | null | undefined): string {
  if (!text) return '';
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Read a skill's curated body + recent history tail as the project context.
 *  Skill system first (memory/projects/ retired 2026-07); legacy project
 *  MEMORY.md as fallback for anything not yet migrated. */
function readSkillProjectContext(skillCategory: string, name: string): string | null {
  try {
    const dir = path.join(GLOBAL_SKILLS_DIR, skillCategory, name);
    const skillFile = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) return null;
    let content = fs.readFileSync(skillFile, 'utf-8');
    const logFile = path.join(dir, 'history', 'log.md');
    if (fs.existsSync(logFile)) {
      // Recent history tail only — the curated body is the main signal.
      const raw = fs.readFileSync(logFile, 'utf-8');
      const tail = raw.length > 4000 ? `[older entries omitted]\n${raw.slice(-4000)}` : raw;
      content += `\n\n## Recent progress (history/log.md)\n${tail}`;
    }
    return content;
  } catch {
    return null;
  }
}

/**
 * Load the project's memory: ONE level. The task model has no category, so
 * there is no parent tier to inject — the project's own skill (found by name
 * across the skill grouping dirs) is the whole context, with the legacy
 * memory/projects/<proj>/MEMORY.md as fallback.
 */
function loadProjectContext(project: string): { path: string; content: string | null } {
  const proj = (project ?? '').trim();
  if (!proj) return { path: '', content: null };
  const location = resolveProjectSkillDir(proj);
  const content = (location ? readSkillProjectContext(location.skillCategory, location.name) : null)
    ?? getProjectMemory(proj.toLowerCase())?.content
    ?? null;
  return { path: proj.toLowerCase(), content };
}

interface EnrichedResult {
  prefix: string;
  hashes: Record<string, string>;
}

/**
 * Build enriched task context by loading full task + hierarchical project memory.
 * Per-level hash dedup: only injects fields whose content changed since last injection.
 *
 * Falls back to buildTaskContextPrefix on any error.
 */
export async function enrichTaskContext(ctx: TaskContext, conversationId?: string): Promise<EnrichedResult> {
  const task = await getTask(ctx.id);

  // Load the project's memory (single level — no category tier)
  const mem = loadProjectContext(task.project ?? '');

  // Compute current hashes — keyed by content source path
  const currentHashes: Record<string, string> = {};
  if (task.note) currentHashes[`note:${task.id}`] = contentHash(task.note);
  if (task.description) currentHashes[`desc:${task.id}`] = contentHash(task.description);
  if (task.summary) currentHashes[`summary:${task.id}`] = contentHash(task.summary);
  if (mem.content) currentHashes[`pm:${mem.path}`] = contentHash(mem.content);

  // Get last injected hashes from chat history (scoped to this conversation)
  const lastHashes = await chatHistory.getLastContextHashes('general', conversationId);

  // Helper: check if content changed
  const unchanged = (key: string): boolean => {
    return !!currentHashes[key] && lastHashes[key] === currentHashes[key];
  };

  // Build enriched context lines
  const lines: string[] = [
    '[Task Context — The user has selected this task in the UI. Their message below is about this task. Answer in the context of this task.]',
  ];

  // Metadata — always injected (small, ~200 tok)
  lines.push(`ID: ${task.id}`);
  lines.push(`Title: ${task.title}`);
  if (task.phase) lines.push(`Phase: ${task.phase}`);
  if (task.status) lines.push(`Status: ${task.status}`);
  if (task.priority && task.priority !== 'none') lines.push(`Priority: ${task.priority}`);
  if (task.starred) lines.push(`Starred: yes`);
  lines.push(`Project: ${task.project || 'Inbox'}`);
  if (ctx.source) lines.push(`Source: ${ctx.source}`);
  if (task.start_date) lines.push(`Start: ${task.start_date}`);
  if (task.due_date) lines.push(`Due: ${task.due_date}`);
  if (task.created_at) lines.push(`Created: ${task.created_at}`);

  // Description
  if (task.description) {
    const key = `desc:${task.id}`;
    if (unchanged(key)) {
      lines.push(`Description: [unchanged since last injection]`);
    } else {
      lines.push(`Description: ${truncateToTokenBudget(task.description, ENRICHED_BUDGETS.description)}`);
    }
  }

  // Summary
  if (task.summary) {
    const key = `summary:${task.id}`;
    if (unchanged(key)) {
      lines.push(`Summary: [unchanged since last injection]`);
    } else {
      lines.push(`Summary: ${truncateToTokenBudget(task.summary, ENRICHED_BUDGETS.summary)}`);
    }
  }

  // Note — the most important field
  if (task.note) {
    const key = `note:${task.id}`;
    if (unchanged(key)) {
      lines.push(`Note: [unchanged since last injection]`);
    } else {
      lines.push(`Note:\n${truncateToTokenBudget(task.note, ENRICHED_BUDGETS.note)}`);
    }
  }

  // Conversation log
  if (task.conversation_log) {
    const tokens = task.conversation_log.length / 3.5; // rough estimate
    if (tokens <= ENRICHED_BUDGETS.conversationLog) {
      lines.push(`Conversation Log (recent):\n${task.conversation_log}`);
    } else {
      // Tail-truncate: keep the most recent entries
      const charBudget = Math.floor(ENRICHED_BUDGETS.conversationLog * 3.5);
      const raw = task.conversation_log.slice(-charBudget);
      const headingIdx = raw.indexOf('### ');
      const truncated = '[older entries omitted]\n' + (headingIdx >= 0 ? raw.slice(headingIdx) : raw).trim();
      lines.push(`Conversation Log (recent):\n${truncated}`);
    }
  }

  // Project memory (the only tier)
  if (mem.content) {
    const key = `pm:${mem.path}`;
    const label = task.project;
    if (unchanged(key)) {
      lines.push(`\n[Project Memory: ${label}] [unchanged since last injection]`);
    } else {
      lines.push(`\n[Project Memory: ${label}]\n${truncateToTokenBudget(mem.content, ENRICHED_BUDGETS.projectMemory)}`);
    }
  }

  // Session slots — same as buildTaskContextPrefix
  if (ctx.plan_session_id) {
    const ss = ctx.plan_session_status;
    const parts = ss ? [ss.process_status, ...(ss.activity ? [ss.activity] : [])].join(', ') : '';
    lines.push(`Plan session: ${ctx.plan_session_id}${parts ? ` (${parts})` : ''}`);
  }
  if (ctx.exec_session_id) {
    const ss = ctx.exec_session_status;
    const parts = ss ? [ss.process_status, ...(ss.activity ? [ss.activity] : [])].join(', ') : '';
    lines.push(`Exec session: ${ctx.exec_session_id}${parts ? ` (${parts})` : ''}`);
  }

  lines.push('[/Task Context]');
  return {
    prefix: lines.join('\n') + '\n\n',
    hashes: currentHashes,
  };
}

/**
 * Fire-and-forget helper: append a conversation log entry to a task after a chat turn.
 * Preserves full user/AI messages — never truncate user input or AI responses.
 * appendConversationLog auto-prepends the timestamp.
 */
async function autoAppendConversationLog(taskId: string, userMessage: string, aiResponse: string, toolNames?: string[]): Promise<void> {
  let aiContent: string
  if (aiResponse) {
    aiContent = aiResponse
  } else if (toolNames && toolNames.length > 0) {
    aiContent = `[Used tools: ${toolNames.join(', ')}]`
  } else {
    aiContent = '[No response]'
  }

  const entry = `**User:** ${userMessage}\n**AI:** ${aiContent}`
  await appendConversationLog(taskId, entry)
}

/**
 * Build a divider string from the compaction result.
 * Shows the structured summary produced by step 2 (summarization).
 * Memory persistence is handled by step 1 (memory flush) — no need to show it here.
 */
export function buildCompactionDivider(oldMsgCount: number, result: CompactionResult | null): string {
  const lines: string[] = [`**Conversation compacted** — ${oldMsgCount} messages summarized into memory.`]

  if (result) {
    lines.push('')
    lines.push(result.summary)
  }

  return lines.join('\n')
}

// ── Entity reference resolution ──

/** Match task-ref tags WITHOUT a label attribute */
const TASK_REF_NO_LABEL_RE = /<task-ref\s+id="([^"]+)"(?!\s+label)\s*\/?>/g
/** Match session-ref tags WITHOUT a label attribute */
const SESSION_REF_NO_LABEL_RE = /<session-ref\s+id="([^"]+)"(?!\s+label)\s*\/?>/g

/**
 * Resolve entity refs in text: fill in missing label attributes on task-ref and session-ref tags.
 * Tags that already have a label are left unchanged.
 */
export async function resolveEntityRefs(text: string): Promise<string> {
  // Collect IDs that need resolution
  const taskIds = new Set<string>()
  const sessionIds = new Set<string>()

  let m: RegExpExecArray | null
  TASK_REF_NO_LABEL_RE.lastIndex = 0
  while ((m = TASK_REF_NO_LABEL_RE.exec(text)) !== null) taskIds.add(m[1])
  SESSION_REF_NO_LABEL_RE.lastIndex = 0
  while ((m = SESSION_REF_NO_LABEL_RE.exec(text)) !== null) sessionIds.add(m[1])

  if (taskIds.size === 0 && sessionIds.size === 0) return text

  // Batch-resolve labels
  const taskLabels = new Map<string, string>()
  const sessionLabels = new Map<string, string>()

  await Promise.all([
    ...Array.from(taskIds).map(async (id) => {
      try {
        const task = await getTask(id)
        const label = task.project ? `${task.project} / ${task.title}` : task.title
        taskLabels.set(id, label)
      } catch (err) {
        log.web.debug('failed to resolve task label', { taskId: id, error: err instanceof Error ? err.message : String(err) })
        taskLabels.set(id, id)
      }
    }),
    ...Array.from(sessionIds).map(async (id) => {
      try {
        const session = await getSessionByClaudeId(id)
        sessionLabels.set(id, session?.title || id)
      } catch (err) {
        log.web.debug('failed to resolve session label', { sessionId: id, error: err instanceof Error ? err.message : String(err) })
        sessionLabels.set(id, id)
      }
    }),
  ])

  // Replace tags — add label attribute
  let result = text
  TASK_REF_NO_LABEL_RE.lastIndex = 0
  result = result.replace(TASK_REF_NO_LABEL_RE, (_match, id: string) => {
    const label = taskLabels.get(id) ?? id
    return `<task-ref id="${id}" label="${label.replace(/"/g, '&quot;')}"/>`
  })
  SESSION_REF_NO_LABEL_RE.lastIndex = 0
  result = result.replace(SESSION_REF_NO_LABEL_RE, (_match, id: string) => {
    const label = sessionLabels.get(id) ?? id
    return `<session-ref id="${id}" label="${label.replace(/"/g, '&quot;')}"/>`
  })

  return result
}

/**
 * Resolve entity refs in API messages: only processes assistant text blocks.
 * Returns a new array with resolved text; original messages are not mutated.
 */
async function resolveMessagesEntityRefs(msgs: MessageParam[]): Promise<MessageParam[]> {
  const resolved: MessageParam[] = []
  for (const msg of msgs) {
    const { role, content } = msg as { role: string; content: unknown }
    if (role === 'assistant' && Array.isArray(content)) {
      const newContent = await Promise.all(
        (content as Array<{ type: string; text?: string; [k: string]: unknown }>).map(async (block) => {
          if (block.type === 'text' && block.text) {
            return { ...block, text: await resolveEntityRefs(block.text) }
          }
          return block
        }),
      )
      resolved.push({ role, content: newContent } as MessageParam)
    } else {
      resolved.push(msg)
    }
  }
  return resolved
}

const TOOL_INPUT_MAX = 500;
const TOOL_RESULT_MAX = 1000;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

/**
 * Extract display blocks from API messages for a single turn.
 * Walks through assistant messages (thinking, text, tool_use) and
 * user messages (tool_result) to build a flat block array that
 * represents everything the agent did during this turn.
 */
export function buildDisplayBlocks(apiMsgs: MessageParam[]): DisplayMessageBlock[] {
  const blocks: DisplayMessageBlock[] = [];
  // Map tool_use id → index in blocks[] for matching results
  const toolUseIndex = new Map<string, number>();

  for (const msg of apiMsgs) {
    const { role, content } = msg as { role: string; content: unknown };

    if (role === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'thinking') {
          blocks.push({ type: 'thinking', content: block.thinking ?? '' });
        } else if (block.type === 'text' && block.text) {
          blocks.push({ type: 'text', content: block.text });
        } else if (block.type === 'tool_use') {
          const truncatedInput: Record<string, unknown> = {};
          if (block.input && typeof block.input === 'object') {
            for (const [k, v] of Object.entries(block.input as Record<string, unknown>)) {
              const s = typeof v === 'string' ? v : JSON.stringify(v);
              truncatedInput[k] = truncate(s, TOOL_INPUT_MAX);
            }
          }
          const idx = blocks.length;
          blocks.push({
            type: 'tool_call',
            name: block.name,
            input: truncatedInput,
            status: 'done',
          });
          toolUseIndex.set(block.id, idx);
        }
      }
    } else if (role === 'user' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const idx = toolUseIndex.get(block.tool_use_id);
          if (idx !== undefined && blocks[idx]?.type === 'tool_call') {
            const raw = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);
            blocks[idx].result = truncate(raw, TOOL_RESULT_MAX);
          }
        }
      }
    }
  }

  return blocks;
}

/**
 * Replace base64 image blocks in API messages with path-based blocks for persistence.
 * Only the first user message should contain images — swap them for lightweight path refs.
 */
function replaceImagesWithPaths(
  msgs: MessageParam[],
  savedImages: Array<{ filePath: string; filename: string; mediaType: string }>,
): MessageParam[] {
  if (savedImages.length === 0) return msgs

  return msgs.map((msg) => {
    const { role, content } = msg as { role: string; content: unknown }
    if (role !== 'user' || !Array.isArray(content)) return msg

    let imageIdx = 0
    const hasImages = (content as Array<{ type: string }>).some(b => b.type === 'image')
    if (!hasImages) return msg

    const newContent = (content as Array<Record<string, unknown>>).map((block) => {
      if (block.type === 'image' && imageIdx < savedImages.length) {
        const saved = savedImages[imageIdx++]
        return {
          type: 'image',
          path: saved.filePath,
          media_type: saved.mediaType,
        }
      }
      return block
    })
    return { role, content: newContent } as unknown as MessageParam
  })
}

/** Per-client, per-agent abort controllers — keyed by `{wsId}:{agentId}`. */
const activeAbortControllers = new Map<string, AbortController>()
/** Auto-incrementing ID for WebSocket clients (used in abort controller keys). */
let nextWsId = 1
const wsIdMap = new WeakMap<WebSocket, number>()
function getWsId(ws: WebSocket): number {
  let id = wsIdMap.get(ws)
  if (id === undefined) { id = nextWsId++; wsIdMap.set(ws, id) }
  return id
}
function abortKey(ws: WebSocket, agentId: string): string {
  return `${getWsId(ws)}:${agentId}`
}

/**
 * Register the "chat" and "chat:stop" RPC methods on the WebSocket handler.
 * Must be called after the WS handler is attached to the server.
 */
export function registerChatRpc(): void {
  // Register stop method — aborts the calling client's active agent turn
  registerMethod('chat:stop', async (payload: unknown, client: WebSocket) => {
    const { agentId: stopAgentId } = (payload ?? {}) as { agentId?: string; conversationId?: string }
    const effectiveAgentId = stopAgentId ? validateAgentId(stopAgentId) : 'general'
    activeAbortControllers.get(abortKey(client, effectiveAgentId))?.abort()
    cancelQuestion(effectiveAgentId) // Also cancel any pending user_ask tool
  })

  // Answer structured questions from the QuestionCard UI
  registerMethod('chat:answer-question', async (payload: unknown) => {
    const { answers, agentId: ansAgentId, conversationId: ansConvId } = payload as { answers: Record<string, string>; agentId?: string; conversationId?: string }
    const effectiveAgentId = ansAgentId ? validateAgentId(ansAgentId) : 'general'
    const conversationId = ansConvId ? validateConversationId(ansConvId) : await getActiveConversationId(effectiveAgentId)
    if (!hasPendingQuestion(effectiveAgentId)) {
      log.web.warn('chat:answer-question received but no pending question', { agentId: effectiveAgentId })
      return
    }
    log.web.info('chat:answer-question received', { answerCount: Object.keys(answers).length, agentId: effectiveAgentId })
    // Persist user's answers as a UI-only chat entry
    const answerLines = Object.entries(answers).map(([k, v]) => `${k}: ${v}`).join('\n')
    await chatHistory.addNotification({ role: 'user', content: answerLines, agentId: effectiveAgentId, conversationId })
    broadcastEvent(EventNames.CHAT_HISTORY_UPDATED, {
      entry: { role: 'user', content: answerLines, source: 'question-answer' },
      agentId: effectiveAgentId,
      conversationId,
    })
    submitAnswers(answers, effectiveAgentId)
  })

  registerMethod('chat', async (payload: unknown, client: WebSocket) => {
    const { message, taskContext, images, imageRefs, source: payloadSource, mode, planModeFirst, planModeOff, agentId: payloadAgentId, conversationId: payloadConvId } = payload as ChatPayload
    const agentId = payloadAgentId ? validateAgentId(payloadAgentId) : 'general'
    // Resolve the conversation: explicit payload id wins, else the agent's active one.
    const conversationId = payloadConvId ? validateConversationId(payloadConvId) : await getActiveConversationId(agentId)
    const chatSource = payloadSource === 'quick-start' ? 'quick-start' as const : undefined
    log.web.info('chat message received', { taskId: taskContext?.id, messageLength: message.length, imageCount: (imageRefs?.length ?? 0) || (images?.length ?? 0), source: payloadSource ?? 'chat', agentId, conversationId })

    // ── Intercept: if this agent is waiting for a question answer, route here ──
    // The agent loop is blocked on user_ask tool. We must NOT enqueue a new
    // turn (that would deadlock — current turn holds the single slot).
    // Instead, resolve the pending question directly.
    if (hasPendingQuestion(agentId)) {
      log.web.info('routing chat message to pending user_ask', { messageLength: message.length, agentId })
      // Persist the user's answer as a UI-only entry so it appears in chat history
      await chatHistory.addNotification({ role: 'user', content: message, agentId, conversationId })
      broadcastEvent(EventNames.CHAT_HISTORY_UPDATED, {
        entry: { role: 'user', content: message, source: 'question-answer' },
        agentId,
        conversationId,
      })
      submitTextAnswer(message, agentId)
      return
    }

    // Pre-process images outside the queue (save to disk, prepare base64 blocks).
    // This avoids holding the queue while doing disk I/O for image uploads.

    // Enrich task context with full content + hash dedup; fall back to truncated prefix on error
    // Task context is General-only — non-General agents are conversational, no task routing
    let contextPrefix = ''
    let contextHashes: Record<string, string> | undefined
    if (taskContext && agentId === 'general') {
      try {
        const enriched = await enrichTaskContext(taskContext, conversationId)
        contextPrefix = enriched.prefix
        contextHashes = enriched.hashes
      } catch (err) {
        log.web.warn('enrichTaskContext failed, falling back to buildTaskContextPrefix', {
          taskId: taskContext.id,
          error: err instanceof Error ? err.message : String(err),
        })
        contextPrefix = buildTaskContextPrefix(taskContext)
      }
    }

    let savedImages: Array<{ filePath: string; filename: string; mediaType: string }> = []
    let imageContentBlocks: unknown[] | null = null
    // `imageRefs` (HTTP-uploaded filenames) is what web clients send — base64 on a
    // WS frame trips the 4MB cap and the socket is closed with 1009. Inline
    // `images` remains for REST callers.
    const processed = await resolvePayloadImages(images, imageRefs)
    if (processed) {
      savedImages = processed.savedImages
      imageContentBlocks = processed.imageContentBlocks
    }

    // Enqueue turn for this agent — per-agent queue, no cross-agent blocking
    log.web.info('enqueueing agent turn', { taskId: taskContext?.id, source: 'chat', agentId })
    await enqueueAgentTurn(agentId, 'chat', async () => {
      // Lazy import to avoid loading the agent at server startup
      const { runAgentLoop } = await import('../../agent/loop.js')

      // Create abort controller for this client + agent combo
      const abortController = new AbortController()
      const aKey = abortKey(client, agentId)
      activeAbortControllers.set(aKey, abortController)
      // Agent-level registry: lets the REST stop endpoint (mobile, no WS
      // identity) abort this turn too. Unregistered on every exit path below.
      const { registerAgentTurnAbort } = await import('../../core/agent-abort-registry.js')
      const unregisterAbort = registerAgentTurnAbort(agentId, abortController)

      // Resolve console agent definition + build system/tools for non-General agents
      let agentSystem: string | undefined
      let agentTools: import('../../agent/tools.js').ToolDefinition[] | undefined
      if (agentId !== 'general') {
        const { getConsoleAgent } = await import('../../core/agent-registry.js')
        const { buildSubagentToolSet } = await import('../../agent/subagent-context.js')
        const { loadContextSources } = await import('../../agent/context-sources.js')
        const agentDef = await getConsoleAgent(agentId)
        if (!agentDef) {
          throw new Error(`Console agent '${agentId}' not found`)
        }
        // Build system prompt: agent's own prompt + context sources + date/time
        const now = new Date()
        const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
        const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
        const contextXml = await loadContextSources(agentDef, {})
        const sections = [
          agentDef.system_prompt ?? `You are ${agentDef.name}.`,
          `\nCurrent date/time: ${dateStr}, ${timeStr}`,
        ]
        if (contextXml) sections.push('\n' + contextXml)
        agentSystem = sections.join('\n')
        // Build filtered tool set (respects allowed_tools / denied_tools)
        agentTools = await buildSubagentToolSet(agentDef)
      }

      // Load existing history from disk (inside queue = reads fresh state)
      const history = await chatHistory.getApiMessages(agentId, conversationId)
      log.agent.info('agent loop starting', { taskId: taskContext?.id, source: 'chat', historyLength: history.length })

      // Drain any pending cron notifications (General only — cron is General's domain)
      const pendingCron = agentId === 'general' ? drainPendingCronNotifications() : []
      let cronPrefix = ''
      if (pendingCron.length > 0) {
        const lines = ['[Pending Cron Notifications — These scheduled jobs fired while you were away. Process them as appropriate.]']
        for (const n of pendingCron) {
          lines.push(`- [${n.jobName}] ${n.text}`)
        }
        lines.push('[/Pending Cron Notifications]')
        cronPrefix = lines.join('\n') + '\n\n'
      }

      // Plan mode prompt injection
      let planPrefix = ''
      let planSuffix = ''
      if (mode === 'plan') {
        if (planModeFirst) {
          planPrefix = PLAN_MODE_FULL_INSTRUCTION + '\n\n'
        } else {
          planSuffix = '\n\n' + PLAN_MODE_REMINDER
        }
      } else if (planModeOff) {
        planPrefix = EXECUTION_MODE_MESSAGE + '\n\n'
      }

      const agentMessage = cronPrefix + planPrefix + contextPrefix + message

      // Build user content with images if present
      let userContent: string | unknown[] = agentMessage + planSuffix
      if (imageContentBlocks) {
        const imageAnnotation = buildImageAnnotation(savedImages)
        imageContentBlocks.push({ type: 'text', text: imageAnnotation + agentMessage })
        // Plan suffix as a separate text block so the model sees it after images
        if (planSuffix) {
          imageContentBlocks.push({ type: 'text', text: planSuffix.trim() })
        }
        userContent = imageContentBlocks
      }

      const turnStartMs = Date.now()
      const toolsUsedInTurn = new Set<string>()

      // ── Eager persist: write user message to disk BEFORE the agent loop.
      // Ensures the message survives page refresh during processing (~5ms write).
      // `history` was captured BEFORE this write, so no duplication in the API call. ──
      const turnId = crypto.randomUUID()
      const userContentForPersist: string | unknown[] = savedImages.length > 0 && Array.isArray(userContent)
        ? (replaceImagesWithPaths(
            [{ role: 'user', content: userContent } as MessageParam],
            savedImages,
          )[0] as { content: unknown[] }).content
        : userContent
      await chatHistory.addUserMessage(userContentForPersist, {
        displayText: message,
        turnId,
        ...(contextHashes && { contextHashes }),
        ...(taskContext?.id && { taskId: taskContext.id }),
        ...(chatSource && { source: chatSource }),
        agentId,
        conversationId,
      })

      try {
        const result = await runAgentLoop(userContent, history, {
          onTextDelta: (delta) => {
            broadcastEvent(EventNames.AGENT_TEXT_DELTA, { delta, agentId, conversationId })
          },
          onToolActivity: (activity) => {
            broadcastEvent(EventNames.AGENT_TOOL_ACTIVITY, { ...activity, agentId, conversationId })
          },
          onThinking: (text) => {
            broadcastEvent(EventNames.AGENT_THINKING, { text, agentId, conversationId })
          },
          onToolCall: (toolName, input, toolUseId) => {
            toolsUsedInTurn.add(toolName)
            trackWmToolCall()
            broadcastEvent(EventNames.AGENT_TOOL_CALL, { toolName, input, toolUseId, agentId, conversationId })
          },
          onToolResult: (toolName, result, toolUseId) => {
            broadcastEvent(EventNames.AGENT_TOOL_RESULT, { toolName, result, toolUseId, agentId, conversationId })
          },
          onUsage: (usage) => {
            bus.emit('agent:usage', { usage }, ['web-ui'], { source: 'agent' })
            try {
              usageTracker.record({
                source: 'agent',
                model: usage.model ?? 'unknown',
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cache_creation_input_tokens: usage.cache_creation_input_tokens,
                cache_read_input_tokens: usage.cache_read_input_tokens,
                agentId,
              })
            } catch (err) {
              log.web.warn('failed to record usage', { error: err instanceof Error ? err.message : String(err) })
            }
            // Cache the EXACT input-token count (incl. cache) so the triage bail
            // pre-check sees this conversation's real size after a chat turn grows it.
            try { recordLastTurnTokens(conversationId, (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)) } catch {}
          },
        // Note: onText is intentionally not provided — agent:response is sent once
        // at the end of the turn (not per text block) so isStreaming stays true
        // for the full loop duration, keeping the Stop button visible.
        }, {
          signal: abortController.signal,
          source: agentId === 'general' ? 'chat' : `chat:${agentId}`,
          agentId,
          conversationId,
          ...(agentSystem && { system: agentSystem }),
          ...(agentTools && { tools: agentTools }),
        })

        activeAbortControllers.delete(aKey)
        unregisterAbort()

        // Handle aborted turn: persist partial response but skip compaction.
        // User message is already on disk (eagerly persisted above).
        if (result.aborted) {
          const allNewMsgs = result.newMessages as MessageParam[]
          // Skip the eagerly-persisted user message (first in the new batch)
          const afterUser = allNewMsgs.length > 0 && (allNewMsgs[0] as { role: string }).role === 'user'
            ? allNewMsgs.slice(1)
            : allNewMsgs

          // Clean trailing: remove trailing user (tool_result) and strip orphan tool_use
          const cleaned = [...afterUser]
          while (cleaned.length > 0) {
            const last = cleaned[cleaned.length - 1] as { role: string; content: unknown }
            if (last.role === 'user') {
              cleaned.pop()
              continue
            }
            if (last.role === 'assistant' && Array.isArray(last.content)
              && (last.content as Array<{ type: string }>).some(b => b.type === 'tool_use')) {
              const kept = (last.content as Array<{ type: string }>).filter(b => b.type !== 'tool_use')
              if (kept.length === 0) {
                cleaned.pop()
                continue
              }
              cleaned[cleaned.length - 1] = { ...last, content: kept } as MessageParam
            }
            break
          }
          if (cleaned.length > 0) {
            const persistMsgs = replaceImagesWithPaths(cleaned, savedImages)
            await chatHistory.addAIMessages(persistMsgs, { ...(chatSource && { source: chatSource }), agentId, conversationId })
          }
          // Even if cleaned is empty, user message is safe on disk ✅
          // Auto-append to conversation_log for aborted turns (General only)
          if (taskContext?.id && agentId === 'general') {
            autoAppendConversationLog(taskContext.id, message, result.response || '[Aborted]', [...toolsUsedInTurn]).catch((err) => {
              log.web.warn('autoAppendConversationLog failed (aborted)', { taskId: taskContext.id, error: err instanceof Error ? err.message : String(err) })
            })
          }
          broadcastEvent(EventNames.AGENT_RESPONSE, { text: result.response, aborted: true, agentId, conversationId })
          return
        }

        // Extract the new messages added during this turn.
        // result.newMessages is [userPrompt, ...ai messages]; the user prompt was
        // already eagerly persisted with turnId, so skip it. Using newMessages (not
        // slice(history.length)) is trim-safe: an emergency trim shortens the front
        // of result.messages, which would make slice(history.length) overshoot and
        // silently drop the assistant reply (the duplicate-task / orphan bug).
        const allNewMsgs = result.newMessages as MessageParam[]
        const newApiMsgs = allNewMsgs.length > 0 && (allNewMsgs[0] as { role: string }).role === 'user'
          ? allNewMsgs.slice(1)
          : allNewMsgs

        // Resolve entity refs before persisting
        const resolvedMsgs = await resolveMessagesEntityRefs(newApiMsgs)
        const resolvedText = await resolveEntityRefs(result.response)

        // Replace base64 image blocks with path-based blocks before persisting
        const persistMsgs = replaceImagesWithPaths(resolvedMsgs, savedImages)

        // Persist AI response only (displayText/contextHashes already on eagerly-persisted user entry)
        await chatHistory.addAIMessages(persistMsgs, {
          ...(taskContext?.id && { taskId: taskContext.id }),
          ...(chatSource && { source: chatSource }),
          agentId,
          conversationId,
        })
        log.agent.info('agent response persisted', { taskId: taskContext?.id, messageCount: newApiMsgs.length })

        // Build lightweight stats from agent loop's token breakdown (avoids expensive re-computation)
        let stats: Record<string, unknown> | undefined
        if (result.tokenBreakdown) {
          const { getContextWindowSize } = await import('../../agent/model.js')
          const { getConfig } = await import('../../core/config-manager.js')
          const config = await getConfig()
          const contextWindow = getContextWindowSize(config.agent?.main_model)
          const compacted = !!(await chatHistory.getCompactionSummary(agentId, conversationId))
          stats = {
            // Display-only stat from the post-loop working array. After a mid-turn
            // 400-trim this is the SHORTENED in-memory array, so it can under-report
            // the on-disk message count — it is never persisted and not the canonical count.
            apiMessageCount: result.messages.filter((m) => !(m as { compacted?: boolean }).compacted).length,
            estimatedTokens: result.tokenBreakdown.messages,
            systemTokens: result.tokenBreakdown.system,
            toolsTokens: result.tokenBreakdown.tools,
            estimatedTotalTokens: result.tokenBreakdown.total,
            compacted,
            contextWindow,
          }
        }

        // Signal turn complete to the client (resets isStreaming).
        // This resolves the RPC immediately — compaction runs separately below.
        broadcastEvent(EventNames.AGENT_RESPONSE, { text: resolvedText, ...(stats ? { stats } : {}), agentId, conversationId })
        log.web.info('chat turn completed', { taskId: taskContext?.id, durationMs: Date.now() - turnStartMs, agentId, conversationId })

        // Auto-append to conversation_log if a task was focused (General only)
        if (taskContext?.id && agentId === 'general') {
          autoAppendConversationLog(taskContext.id, message, result.response, [...toolsUsedInTurn]).catch((err) => {
            log.web.warn('autoAppendConversationLog failed', { taskId: taskContext.id, error: err instanceof Error ? err.message : String(err) })
          })
        }

        // Trigger working memory update if thresholds are met (fire-and-forget).
        // Uses the token breakdown from the agent loop to check triggers.
        if (result.tokenBreakdown && agentId === 'general') {
          const currentTokens = result.tokenBreakdown.total
          if (shouldUpdateWorkingMemory(currentTokens, agentId, conversationId)) {
            executeWorkingMemoryUpdate(
              async (prompt) => {
                const { runAgentLoop } = await import('../../agent/loop.js')
                const { filesTools } = await import('../../agent/tools/files-tools.js')
                // Restrict to file_edit only (not file_write) — the updater should EDIT sections
                // within the existing template, never overwrite the entire file (would destroy structure).
                const editTool = filesTools.find(t => t.name === 'file_edit')
                const allowedTools = editTool ? [editTool] : filesTools
                // Empty history is intentional: the update prompt contains the current working memory
                // content inline. Full conversation context comes from the prompt cache prefix.
                // Passing history would double token cost and defeat the lightweight extraction purpose.
                await runAgentLoop(prompt, [], {
                  onTextDelta: () => {},
                }, {
                  system: 'You are a working memory updater. Your only job is to update the working memory notes file using file_edit. Do not do anything else.',
                  tools: allowedTools,
                  source: 'working-memory-updater',
                  maxToolRounds: 5,
                })
              },
              currentTokens,
              agentId,
              conversationId,
            ).catch(() => { /* non-critical */ })
          }
        }

        // Background self-review: count this clean main-butler turn; every N turns
        // fork the conversation (same cache prefix) for a skill/memory review pass.
        // Fire-and-forget — persistence-isolated, never touches this conversation.
        if (agentId === 'general') {
          import('../../agent/background-review.js')
            .then(({ noteTurnCompleteAndMaybeReview }) => noteTurnCompleteAndMaybeReview({
              agentId,
              conversationId,
              toolsUsed: toolsUsedInTurn,
              getHistory: () => chatHistory.getApiMessages(agentId, conversationId),
            }))
            .catch((err) => {
              log.web.warn('background review trigger failed', { error: err instanceof Error ? err.message : String(err) })
            })
        }

        // Trigger background compaction outside the turn queue.
        // This fires and forgets — the user can send more messages immediately.
        triggerBackgroundCompaction('chat', { agentId, conversationId })
      } catch (err) {
        activeAbortControllers.delete(aKey)
        unregisterAbort()
        const errMsg = err instanceof Error ? err.message : String(err)
        log.web.error('chat turn error', { taskId: taskContext?.id, source: 'chat', error: errMsg, agentId })

        // User message already on disk (eagerly persisted). Only add synthetic error response.
        await chatHistory.addAIMessages(
          [
            { role: 'assistant', content: [{ type: 'text', text: `[Error: ${errMsg}]` }] },
          ] as MessageParam[],
          { source: 'agent-error', agentId, conversationId },
        )

        // Push it live. addAIMessages only writes to DISK — without this the error
        // was invisible until a page refresh, and then indistinguishable from a
        // short normal reply. That is how an 18h all-turns-failing outage went
        // unnoticed (2026-07-26: every turn returned `[Error: 403 …]`).
        broadcastEvent(EventNames.CHAT_HISTORY_UPDATED, {
          entry: {
            role: 'assistant',
            content: `[Error: ${errMsg}]`,
            source: 'agent-error',
            notification: true,
            timestamp: new Date().toISOString(),
          },
          agentId,
          conversationId,
        })

        // Auto-append to conversation_log for error turns (General only)
        if (taskContext?.id && agentId === 'general') {
          autoAppendConversationLog(taskContext.id, message, `[Error: ${errMsg}]`, [...toolsUsedInTurn]).catch(() => { /* non-critical */ })
        }

        broadcastEvent(EventNames.AGENT_ERROR, { error: errMsg, agentId, conversationId })
      }
    })
  })
}
