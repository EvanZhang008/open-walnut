/**
 * Chat route — bridges WebSocket RPC to the conversation's Personal AI lane.
 *
 * Server is the source of truth for conversation history.
 * Client sends only { message }, server loads history from ChatHistoryManager,
 * delivers the turn into the lane session, and persists the new turn to disk.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { MessageParam } from '../../model/model.js'
import type { DisplayMessageBlock } from '../../core/types.js'
import type { CompactionResult } from '../../core/chat-history.js'
import { registerMethod, broadcastEvent } from '../ws/handler.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { usageTracker } from '../../core/usage/index.js'
import * as chatHistory from '../../core/chat-history.js'
import { getActiveConversationId } from '../../core/conversations.js'
import { drainPendingCronNotifications } from '../server.js'
import { getTask } from '../../core/task-manager.js'
import { getProjectMemory } from '../../core/project-memory.js'
import { resolveProjectSkillDir } from '../../core/overview-log.js'
import { getSessionByClaudeId } from '../../core/session-tracker.js'
import { resolvePayloadImages, buildImageAnnotation, buildSessionImageContext } from './images.js'
import type { ImagePayload, ImageRef } from './images.js'
import { truncateToTokenBudget } from '../../utils/token-truncate.js'
import { log } from '../../logging/index.js'
import { validateAgentId, validateConversationId, GLOBAL_SKILLS_DIR } from '../../constants.js'
import { enqueueAgentTurn, getLastTurnTokens } from '../agent-turn-queue.js'
import {
  shouldUpdateWorkingMemory,
  executeWorkingMemoryUpdate,
  runWorkingMemoryUpdate,
  trackToolCall as trackWmToolCall,
} from '../../core/memory/working-memory-updater.js'

/**
 * Track usage for the compaction summarizer.
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

/** Concatenate the text blocks of a one-shot model answer. */
function answerText(content: Array<{ type: string; text?: string }> | undefined): string {
  return (content ?? [])
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('')
}

/**
 * Create the summarizer callback for compaction.
 * Shared by the WebSocket chat handler and the REST /compact endpoint.
 */
export async function createCompactionCallbacks(options?: { trackUsage?: boolean }): Promise<{
  summarizer: (instruction: string, history: MessageParam[]) => Promise<string>
}> {
  const { sendMessage } = await import('../../model/model.js')
  // The usage row's model label: a one-shot answer does not carry one (only the
  // agent loop stamped it), so read the configured main model once here rather
  // than filing every compaction call under 'unknown'.
  let usageModel: string | undefined
  if (options?.trackUsage) {
    try {
      const { getConfig } = await import('../../core/config-manager.js')
      usageModel = (await getConfig()).agent?.main_model
    } catch { /* label only — never fail compaction over it */ }
  }

  // Summarizer: ONE call, no tools. It receives the conversation as real
  // MessageParam[] history (not serialized text) so the provider sees the same
  // message prefix the chat does.
  //
  // Reference max_tokens for compaction summaries:
  // - Claude Code CLI: 20,000 (hardcoded in binary, thinking disabled)
  // - Moltbot: 13,107–16,000 (0.8 × reserveTokens; range because reserveTokens
  //   defaults to 16,384 from SDK but moltbot overrides the floor to 20,000 via
  //   DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR in pi-settings.ts)
  const summarizer = async (instruction: string, history: MessageParam[]) => {
    const result = await sendMessage({
      system: 'You summarize conversations into a structured checkpoint. Follow the instruction exactly and answer with the summary only.',
      messages: [...history, { role: 'user', content: instruction }],
      config: { maxTokens: 20_000 },
    })
    if (options?.trackUsage && result.usage) {
      trackCompactionUsage({ ...result.usage, model: result.usage.model ?? usageModel })
    }
    return answerText(result.content as Array<{ type: string; text?: string }>)
  }

  return { summarizer }
}

interface TaskContext {
  id: string
  title: string
  project?: string
  status?: string
  phase?: string
  priority?: string
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

/**
 * Register the "chat" and "chat:stop" RPC methods on the WebSocket handler.
 * Must be called after the WS handler is attached to the server.
 */
export function registerChatRpc(): void {
  // Register stop method — interrupts the agent's turn
  registerMethod('chat:stop', async (payload: unknown) => {
    const { agentId: stopAgentId, conversationId: stopConvId } = (payload ?? {}) as { agentId?: string; conversationId?: string }
    const effectiveAgentId = stopAgentId ? validateAgentId(stopAgentId) : 'general'
    // The turn runs in a `claude` CLI, which no AbortController can reach —
    // interrupt the lane's session through the canonical bus path. Unconditional:
    // the lookup is one indexed sqlite read and resolves null for a conversation
    // that has no lane record yet.
    try {
      const conversationId = stopConvId
        ? validateConversationId(stopConvId)
        : await getActiveConversationId(effectiveAgentId)
      const { interruptLaneForConversation } = await import('../../core/sessions/personal-ai-lane.js')
      await interruptLaneForConversation(effectiveAgentId, conversationId)
    } catch (err) {
      // A failed lane stop must never surface as an RPC error — the client's stop
      // is done either way.
      log.web.warn('chat:stop lane interrupt failed', {
        agentId: effectiveAgentId, error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  registerMethod('chat', async (payload: unknown) => {
    const { message, taskContext, images, imageRefs, source: payloadSource, mode, planModeFirst, planModeOff, agentId: payloadAgentId, conversationId: payloadConvId } = payload as ChatPayload
    const agentId = payloadAgentId ? validateAgentId(payloadAgentId) : 'general'
    // Resolve the conversation: explicit payload id wins, else the agent's active one.
    const conversationId = payloadConvId ? validateConversationId(payloadConvId) : await getActiveConversationId(agentId)
    const chatSource = payloadSource === 'quick-start' ? 'quick-start' as const : undefined
    log.web.info('chat message received', { taskId: taskContext?.id, messageLength: message.length, imageCount: (imageRefs?.length ?? 0) || (images?.length ?? 0), source: payloadSource ?? 'chat', agentId, conversationId })

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

    /** The lane session that ran the turn, so the client can subscribe to its stream. */
    let laneSessionId: string | undefined

    // Enqueue turn for this agent — per-agent queue, no cross-agent blocking
    log.web.info('enqueueing agent turn', { taskId: taskContext?.id, source: 'chat', agentId })
    await enqueueAgentTurn(agentId, 'chat', async () => {
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

      // ── Eager persist: write the user message to disk BEFORE the turn runs.
      // Ensures the message survives page refresh during processing (~5ms write). ──
      //
      // The id also travels: it rides every agent:* event of this turn AND the
      // assistant entries it persists, which makes it the browser's only stable
      // per-message handle in this lane — `<suggest>` action cards key their
      // "already clicked" receipts on it, so a card has ONE identity while it
      // streams and after a reload. It cannot be delivered on the RPC's return
      // value: that promise resolves only after the turn ends, long after the
      // first card is clickable.
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

      // ── The turn runs in the conversation's lane session ──
      // AWAITED, and its stream is relayed onto this chat's own agent:* events:
      // the lane session is an implementation detail, the chat panel is the one
      // and only surface for a main-AI turn.
      try {
        // ── Turn-boundary memory bookkeeping ──
        // Every Personal AI turn owes memory two things: resetting the
        // memory-consolidation breaker, and re-pinning the frozen memory-prompt
        // snapshot for this conversation. Without them the breaker's
        // consecutive-failure count never clears (one bad turn wedges
        // consolidation for the process's life) and the prompt scope never
        // advances.
        try {
          const { getBoundedMemory, beginMemoryPromptTurn } = await import('../../core/bounded-memory.js')
          getBoundedMemory().resetConsolidationFailures()
          getBoundedMemory(undefined, 'user').resetConsolidationFailures()
          const { drift } = beginMemoryPromptTurn(agentId, conversationId)
          for (const d of drift) {
            if (d.origin !== 'external') continue
            // Not an error: the new bytes ARE adopted from this turn on. But these
            // paths (hand edit, file_write on a memory path, data-repo sync, the web
            // editor) bypass every write-time check, so make it visible.
            log.web.warn('memory changed outside the memory tool; adopted this turn', {
              scope: d.scope, previousHash: d.previousHash, currentHash: d.currentHash,
              agentId, conversationId,
            })
          }
        } catch (err) {
          log.web.warn('lane turn memory bookkeeping failed; continuing', {
            agentId, conversationId, error: err instanceof Error ? err.message : String(err),
          })
        }

        // The CLI takes plain text on stdin, not content blocks — images ride as
        // readable file paths (the same shape session chat uses), never base64.
        const sessionMessage = savedImages.length > 0
          ? buildSessionImageContext(savedImages) + agentMessage + planSuffix
          : agentMessage + planSuffix

        // ── Live relay: the lane session's stream → this chat's own agent:*
        // events. COMPAT SHIM: the current web client mounts the session
        // timeline directly on the lane (SessionChatHistory + session:send) and
        // rarely calls this RPC at all — it mostly serves a stale bundle. It
        // relays the stream live and persists ONLY the final answer; the turn's
        // full transcript (tools included) lives in the CLI's own JSONL, which
        // is the one source of truth (no duplicate tool-block persistence here).
        const relayName = `chat-lane-relay-${turnId}`
        let relaySessionId: string | null = null

        // Thinking arrives as deltas, but agent:thinking consumers render one
        // block per event — buffer and flush per contiguous thinking run. A
        // TIMED flush (1.5s) caps how long the buffer can sit: a turn that opens
        // with a long thinking phase would otherwise paint NOTHING until its
        // first tool call — reads as "sent a message, app is dead".
        let thinkingBuf = ''
        let thinkingTimer: ReturnType<typeof setTimeout> | undefined
        const flushThinking = (): void => {
          if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = undefined }
          if (thinkingBuf.trim()) {
            broadcastEvent(EventNames.AGENT_THINKING, { text: thinkingBuf, agentId, conversationId, turnId })
          }
          thinkingBuf = ''
        }
        bus.subscribe(relayName, (event) => {
          const d = event.data as {
            sessionId?: string; parentToolUseId?: string; replayed?: boolean;
            delta?: string; toolName?: string; toolUseId?: string;
            input?: Record<string, unknown>; result?: string;
          }
          if (relaySessionId === null || d.sessionId !== relaySessionId) return
          // Subagent output belongs to its own lane, and a replayed event is
          // JSONL history being re-read — neither is this turn's live stream.
          if (d.parentToolUseId || d.replayed) return
          if (event.name === EventNames.SESSION_TEXT_DELTA) {
            flushThinking()
            // No sessionId in the payload: useChat drops agent:text-delta
            // events that carry one (they'd be a session's, not the chat's).
            if (d.delta) {
              broadcastEvent(EventNames.AGENT_TEXT_DELTA, { delta: d.delta, agentId, conversationId, turnId })
            }
          } else if (event.name === EventNames.SESSION_THINKING_DELTA) {
            if (d.delta) {
              thinkingBuf += d.delta
              thinkingTimer ??= setTimeout(flushThinking, 1500)
            }
          } else if (event.name === EventNames.SESSION_TOOL_USE) {
            flushThinking()
            // Real per-tool counting for the working-memory trigger.
            trackWmToolCall(agentId, conversationId)
            broadcastEvent(EventNames.AGENT_TOOL_CALL, {
              toolName: d.toolName, input: d.input, toolUseId: d.toolUseId, agentId, conversationId, turnId,
            })
          } else if (event.name === EventNames.SESSION_TOOL_RESULT) {
            // toolName is not on the session event; the client matches by toolUseId.
            broadcastEvent(EventNames.AGENT_TOOL_RESULT, {
              toolName: '', result: d.result, toolUseId: d.toolUseId, agentId, conversationId, turnId,
            })
          }
        }, { global: true, interest: [
          EventNames.SESSION_TEXT_DELTA, EventNames.SESSION_THINKING_DELTA,
          EventNames.SESSION_TOOL_USE, EventNames.SESSION_TOOL_RESULT,
        ] })

        try {
          // AWAITED: the reply belongs in this chat. runLaneTurn owns
          // create/send/result-correlation (lane-turn.ts); onSessionId fires
          // before the send, so the relay can't miss a delta.
          // 30 min ceiling — a chat turn that long has effectively hung.
          const { runLaneTurn } = await import('../../core/sessions/lane-turn.js')
          const { sessionId, resultText } = await runLaneTurn(agentId, conversationId, sessionMessage, {
            source: 'chat',
            timeoutMs: 1_800_000,
            onSessionId: (sid) => { relaySessionId = sid },
          })
          laneSessionId = sessionId
          flushThinking()

          // ── Working-memory updater ──
          // Tool calls were counted per relayed session:tool-use above; the token
          // size is the lane's last exact API input count (fed by the
          // session:usage-update handler in server.ts), 0 until the lane's first
          // assistant message reports usage — 0 simply fails the threshold.
          // Fire-and-forget: the answer must not wait on it.
          if (agentId === 'general') {
            const laneTokens = getLastTurnTokens(conversationId) ?? 0
            if (shouldUpdateWorkingMemory(laneTokens, agentId, conversationId)) {
              executeWorkingMemoryUpdate(
                runWorkingMemoryUpdate,
                laneTokens,
                agentId,
                conversationId,
              ).catch(() => { /* non-critical */ })
            }
          }

          if (resultText === null) {
            // Timeout / session:error / failed send — the user must see a real
            // error in chat, not silence (the catch below persists it).
            throw new Error('The main AI did not answer this turn (timed out or errored).')
          }

          // Persist ONLY the final answer (compat shim, see above): the turn's
          // full transcript — tools included — is the CLI's own JSONL, which
          // the session timeline renders directly. Refs are resolved BEFORE
          // persisting, so the stored text matches what the client rendered.
          const resolvedText = await resolveEntityRefs(resultText)
          await chatHistory.addAIMessages(
            [{ role: 'assistant', content: [{ type: 'text', text: resolvedText }] }] as MessageParam[],
            { agentId, conversationId, turnId },
          )
          broadcastEvent(EventNames.AGENT_RESPONSE, { text: resolvedText, agentId, conversationId, turnId })
          log.web.info('chat lane turn completed', {
            agentId, conversationId, sessionId, resultLength: resultText.length,
            durationMs: Date.now() - turnStartMs,
          })
        } finally {
          bus.unsubscribe(relayName)
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        log.web.error('Personal AI lane turn failed', { agentId, conversationId, error: errMsg })
        await chatHistory.addAIMessages(
          [{ role: 'assistant', content: [{ type: 'text', text: `[Error: ${errMsg}]` }] }] as MessageParam[],
          { source: 'agent-error', agentId, conversationId },
        )
        broadcastEvent(EventNames.CHAT_HISTORY_UPDATED, {
          entry: {
            role: 'assistant', content: `[Error: ${errMsg}]`, source: 'agent-error',
            notification: true, timestamp: new Date().toISOString(),
          },
          agentId,
          conversationId,
        })
        broadcastEvent(EventNames.AGENT_ERROR, { error: errMsg, agentId, conversationId })
      }
    })

    // Answer with the session that ran the turn, so the client can subscribe to
    // its stream / open its panel. Undefined (→ no payload) when the turn never
    // reached a lane, which is the reply shape every pre-lane caller expects.
    if (laneSessionId) return { laneSessionId }
  })
}
