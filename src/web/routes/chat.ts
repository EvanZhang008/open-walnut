/**
 * Chat route — bridges WebSocket RPC to the agent loop.
 *
 * Server is the source of truth for conversation history.
 * Client sends only { message }, server loads history from ChatHistoryManager,
 * runs the agent loop, and persists the new turn to disk.
 */

import crypto from 'node:crypto'
import type { WebSocket } from 'ws'
import type { MessageParam } from '../../agent/model.js'
import type { DisplayMessageBlock } from '../../core/types.js'
import type { CompactionResult } from '../../core/chat-history.js'
import { MEMORY_FLUSH_MESSAGE } from '../../core/chat-history.js'
import { registerMethod, broadcastEvent } from '../ws/handler.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { usageTracker } from '../../core/usage/index.js'
import * as chatHistory from '../../core/chat-history.js'
import { drainPendingCronNotifications } from '../server.js'
import { getTask, appendConversationLog } from '../../core/task-manager.js'
import { getProjectMemory } from '../../core/project-memory.js'
import { getSessionByClaudeId } from '../../core/session-tracker.js'
import { processAndSaveImages, buildImageAnnotation } from './images.js'
import type { ImagePayload } from './images.js'
import { truncateToTokenBudget } from '../../utils/token-truncate.js'
import { log } from '../../logging/index.js'
import { enqueueMainAgentTurn } from '../agent-turn-queue.js'
import { triggerBackgroundCompaction } from '../background-compaction.js'
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
  category?: string
  project?: string
  status?: string
  phase?: string
  priority?: string
  starred?: boolean
  due_date?: string
  source?: string
  description?: string
  summary?: string
  note?: string
  conversation_log?: string
  created_at?: string
  plan_session_id?: string
  plan_session_status?: { work_status: string; process_status: string; activity?: string }
  exec_session_id?: string
  exec_session_status?: { work_status: string; process_status: string; activity?: string }
}

interface ChatPayload {
  message: string
  taskContext?: TaskContext
  images?: ImagePayload[]
  source?: string
}

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
  if (ctx.category) lines.push(`Category: ${ctx.category}`)
  if (ctx.project && ctx.project !== ctx.category) lines.push(`Project: ${ctx.project}`)
  if (ctx.source) lines.push(`Source: ${ctx.source}`)
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
    const parts = ss ? [ss.process_status, ss.work_status, ...(ss.activity ? [ss.activity] : [])].join(', ') : ''
    lines.push(`Plan session: ${ctx.plan_session_id}${parts ? ` (${parts})` : ''}`)
  }
  if (ctx.exec_session_id) {
    const ss = ctx.exec_session_status
    const parts = ss ? [ss.process_status, ss.work_status, ...(ss.activity ? [ss.activity] : [])].join(', ') : ''
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
  parentMemory: 1000,
  conversationLog: 500,
} as const;

/** SHA256 hash of a string. Returns empty string for empty/null input. */
function contentHash(text: string | null | undefined): string {
  if (!text) return '';
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Load hierarchical project memory: parent (category) + self (project).
 * Returns { parentPath, parentContent, selfPath, selfContent }.
 */
function loadHierarchicalMemory(category: string, project: string): {
  parentPath: string | null; parentContent: string | null;
  selfPath: string; selfContent: string | null;
} {
  const catLower = category.toLowerCase();
  const projLower = project.toLowerCase();
  const selfPath = `${catLower}/${projLower}`;

  // Self = project-level memory
  const selfResult = getProjectMemory(selfPath);
  const selfContent = selfResult?.content ?? null;

  // Parent = category-level memory (only if project !== category, i.e. 2 levels)
  let parentPath: string | null = null;
  let parentContent: string | null = null;
  if (projLower !== catLower) {
    parentPath = catLower;
    const parentResult = getProjectMemory(catLower);
    parentContent = parentResult?.content ?? null;
  }

  return { parentPath, parentContent, selfPath, selfContent };
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
export async function enrichTaskContext(ctx: TaskContext): Promise<EnrichedResult> {
  const task = await getTask(ctx.id);

  // Load hierarchical memory
  const mem = loadHierarchicalMemory(task.category, task.project);

  // Compute current hashes — keyed by content source path
  const currentHashes: Record<string, string> = {};
  if (task.note) currentHashes[`note:${task.id}`] = contentHash(task.note);
  if (task.description) currentHashes[`desc:${task.id}`] = contentHash(task.description);
  if (task.summary) currentHashes[`summary:${task.id}`] = contentHash(task.summary);
  if (mem.selfContent) currentHashes[`pm:${mem.selfPath}`] = contentHash(mem.selfContent);
  if (mem.parentPath && mem.parentContent) currentHashes[`pm:${mem.parentPath}`] = contentHash(mem.parentContent);

  // Get last injected hashes from chat history
  const lastHashes = await chatHistory.getLastContextHashes();

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
  if (task.category) lines.push(`Category: ${task.category}`);
  if (task.project && task.project !== task.category) lines.push(`Project: ${task.project}`);
  if (ctx.source) lines.push(`Source: ${ctx.source}`);
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

  // Parent memory (category level)
  if (mem.parentPath && mem.parentContent) {
    const key = `pm:${mem.parentPath}`;
    const label = task.category;
    if (unchanged(key)) {
      lines.push(`\n[Category Memory: ${label}] [unchanged since last injection]`);
    } else {
      lines.push(`\n[Category Memory: ${label}]\n${truncateToTokenBudget(mem.parentContent, ENRICHED_BUDGETS.parentMemory)}`);
    }
  }

  // Project memory (self level)
  if (mem.selfContent) {
    const key = `pm:${mem.selfPath}`;
    const label = task.project;
    if (unchanged(key)) {
      lines.push(`\n[Project Memory: ${label}] [unchanged since last injection]`);
    } else {
      lines.push(`\n[Project Memory: ${label}]\n${truncateToTokenBudget(mem.selfContent, ENRICHED_BUDGETS.projectMemory)}`);
    }
  }

  // Session slots — same as buildTaskContextPrefix
  if (ctx.plan_session_id) {
    const ss = ctx.plan_session_status;
    const parts = ss ? [ss.process_status, ss.work_status, ...(ss.activity ? [ss.activity] : [])].join(', ') : '';
    lines.push(`Plan session: ${ctx.plan_session_id}${parts ? ` (${parts})` : ''}`);
  }
  if (ctx.exec_session_id) {
    const ss = ctx.exec_session_status;
    const parts = ss ? [ss.process_status, ss.work_status, ...(ss.activity ? [ss.activity] : [])].join(', ') : '';
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
        const label = task.project && task.project !== task.category
          ? `${task.project} / ${task.title}`
          : task.title
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

/** Per-client abort controllers — keyed by WebSocket so each client can only stop its own turn. */
const activeAbortControllers = new Map<WebSocket, AbortController>()

/**
 * Register the "chat" and "chat:stop" RPC methods on the WebSocket handler.
 * Must be called after the WS handler is attached to the server.
 */
export function registerChatRpc(): void {
  // Register stop method — aborts the calling client's active agent turn
  registerMethod('chat:stop', async (_payload: unknown, client: WebSocket) => {
    activeAbortControllers.get(client)?.abort()
    cancelQuestion() // Also cancel any pending ask_question tool
  })

  // Answer structured questions from the QuestionCard UI
  registerMethod('chat:answer-question', async (payload: unknown) => {
    const { answers } = payload as { answers: Record<string, string> }
    if (!hasPendingQuestion()) {
      log.web.warn('chat:answer-question received but no pending question')
      return
    }
    log.web.info('chat:answer-question received', { answerCount: Object.keys(answers).length })
    // Persist user's answers as a UI-only chat entry
    const answerLines = Object.entries(answers).map(([k, v]) => `${k}: ${v}`).join('\n')
    await chatHistory.addNotification({ role: 'user', content: answerLines })
    broadcastEvent(EventNames.CHAT_HISTORY_UPDATED, {
      entry: { role: 'user', content: answerLines, source: 'question-answer' },
    })
    submitAnswers(answers)
  })

  registerMethod('chat', async (payload: unknown, client: WebSocket) => {
    const { message, taskContext, images, source: payloadSource } = payload as ChatPayload
    const chatSource = payloadSource === 'quick-start' ? 'quick-start' as const : undefined
    log.web.info('chat message received', { taskId: taskContext?.id, messageLength: message.length, imageCount: images?.length ?? 0, source: payloadSource ?? 'chat' })

    // ── Intercept: if the agent is waiting for a question answer, route here ──
    // The agent loop is blocked on ask_question tool. We must NOT enqueue a new
    // turn (that would deadlock — current turn holds the single slot).
    // Instead, resolve the pending question directly.
    if (hasPendingQuestion()) {
      log.web.info('routing chat message to pending ask_question', { messageLength: message.length })
      // Persist the user's answer as a UI-only entry so it appears in chat history
      await chatHistory.addNotification({ role: 'user', content: message })
      broadcastEvent(EventNames.CHAT_HISTORY_UPDATED, {
        entry: { role: 'user', content: message, source: 'question-answer' },
      })
      submitTextAnswer(message)
      return
    }

    // Pre-process images outside the queue (save to disk, prepare base64 blocks).
    // This avoids holding the queue while doing disk I/O for image uploads.

    // Enrich task context with full content + hash dedup; fall back to truncated prefix on error
    let contextPrefix = ''
    let contextHashes: Record<string, string> | undefined
    if (taskContext) {
      try {
        const enriched = await enrichTaskContext(taskContext)
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
    if (images && images.length > 0) {
      const processed = await processAndSaveImages(images)
      if (processed) {
        savedImages = processed.savedImages
        imageContentBlocks = processed.imageContentBlocks
      }
    }

    // Enqueue the main agent turn — serialized with cron and triage turns
    log.web.info('enqueueing agent turn', { taskId: taskContext?.id, source: 'chat' })
    await enqueueMainAgentTurn('chat', async () => {
      // Lazy import to avoid loading the agent at server startup
      const { runAgentLoop } = await import('../../agent/loop.js')

      // Create abort controller for this client's turn
      const abortController = new AbortController()
      activeAbortControllers.set(client, abortController)

      // Load existing history from disk (inside queue = reads fresh state)
      const history = await chatHistory.getApiMessages()
      log.agent.info('agent loop starting', { taskId: taskContext?.id, source: 'chat', historyLength: history.length })

      // Drain any pending cron notifications (queued by next-cycle jobs)
      const pendingCron = drainPendingCronNotifications()
      let cronPrefix = ''
      if (pendingCron.length > 0) {
        const lines = ['[Pending Cron Notifications — These scheduled jobs fired while you were away. Process them as appropriate.]']
        for (const n of pendingCron) {
          lines.push(`- [${n.jobName}] ${n.text}`)
        }
        lines.push('[/Pending Cron Notifications]')
        cronPrefix = lines.join('\n') + '\n\n'
      }

      const agentMessage = cronPrefix + contextPrefix + message

      // Build user content with images if present
      let userContent: string | unknown[] = agentMessage
      if (imageContentBlocks) {
        const imageAnnotation = buildImageAnnotation(savedImages)
        imageContentBlocks.push({ type: 'text', text: imageAnnotation + agentMessage })
        userContent = imageContentBlocks
      }

      const turnStartMs = Date.now()
      const toolsUsedInTurn = new Set<string>()
      try {
        const result = await runAgentLoop(userContent, history, {
          onTextDelta: (delta) => {
            broadcastEvent(EventNames.AGENT_TEXT_DELTA, { delta })
          },
          onToolActivity: (activity) => {
            broadcastEvent(EventNames.AGENT_TOOL_ACTIVITY, activity)
          },
          onThinking: (text) => {
            broadcastEvent(EventNames.AGENT_THINKING, { text })
          },
          onToolCall: (toolName, input, toolUseId) => {
            toolsUsedInTurn.add(toolName)
            broadcastEvent(EventNames.AGENT_TOOL_CALL, { toolName, input, toolUseId })
          },
          onToolResult: (toolName, result, toolUseId) => {
            broadcastEvent(EventNames.AGENT_TOOL_RESULT, { toolName, result, toolUseId })
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
              })
            } catch (err) {
              log.web.warn('failed to record usage', { error: err instanceof Error ? err.message : String(err) })
            }
          },
        // Note: onText is intentionally not provided — agent:response is sent once
        // at the end of the turn (not per text block) so isStreaming stays true
        // for the full loop duration, keeping the Stop button visible.
        }, { signal: abortController.signal, source: 'chat' })

        activeAbortControllers.delete(client)

        // Handle aborted turn: persist partial response but skip compaction.
        if (result.aborted) {
          const newApiMsgs = result.messages.slice(history.length) as MessageParam[]
          while (newApiMsgs.length > 0) {
            const last = newApiMsgs[newApiMsgs.length - 1] as { role: string; content: unknown }
            if (last.role === 'user') {
              newApiMsgs.pop()
              continue
            }
            if (last.role === 'assistant' && Array.isArray(last.content)
              && (last.content as Array<{ type: string }>).some(b => b.type === 'tool_use')) {
              const kept = (last.content as Array<{ type: string }>).filter(b => b.type !== 'tool_use')
              if (kept.length === 0) {
                newApiMsgs.pop()
                continue
              }
              newApiMsgs[newApiMsgs.length - 1] = { ...last, content: kept } as MessageParam
            }
            break
          }
          if (newApiMsgs.length > 0) {
            const persistMsgs = replaceImagesWithPaths(newApiMsgs, savedImages)
            await chatHistory.addAIMessages(persistMsgs, { displayText: message, ...(chatSource && { source: chatSource }) })
          }
          // Auto-append to conversation_log for aborted turns
          if (taskContext?.id) {
            autoAppendConversationLog(taskContext.id, message, result.response || '[Aborted]', [...toolsUsedInTurn]).catch((err) => {
              log.web.warn('autoAppendConversationLog failed (aborted)', { taskId: taskContext.id, error: err instanceof Error ? err.message : String(err) })
            })
          }
          broadcastEvent(EventNames.AGENT_RESPONSE, { text: result.response, aborted: true })
          return
        }

        // Extract the new messages added during this turn
        const newApiMsgs = result.messages.slice(history.length) as MessageParam[]

        // Resolve entity refs before persisting
        const resolvedMsgs = await resolveMessagesEntityRefs(newApiMsgs)
        const resolvedText = await resolveEntityRefs(result.response)

        // Replace base64 image blocks with path-based blocks before persisting
        const persistMsgs = replaceImagesWithPaths(resolvedMsgs, savedImages)

        // Persist to disk (include contextHashes for dedup on next turn)
        await chatHistory.addAIMessages(persistMsgs, {
          displayText: message,
          ...(contextHashes && { contextHashes }),
          ...(taskContext?.id && { taskId: taskContext.id }),
          ...(chatSource && { source: chatSource }),
        })
        log.agent.info('agent response persisted', { taskId: taskContext?.id, messageCount: newApiMsgs.length })

        // Build lightweight stats from agent loop's token breakdown (avoids expensive re-computation)
        let stats: Record<string, unknown> | undefined
        if (result.tokenBreakdown) {
          const { getContextWindowSize } = await import('../../agent/model.js')
          const { getConfig } = await import('../../core/config-manager.js')
          const config = await getConfig()
          const contextWindow = getContextWindowSize(config.agent?.main_model)
          const compacted = !!(await chatHistory.getCompactionSummary())
          stats = {
            apiMessageCount: result.messages.filter((m: { compacted?: boolean }) => !m.compacted).length,
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
        broadcastEvent(EventNames.AGENT_RESPONSE, { text: resolvedText, ...(stats ? { stats } : {}) })
        log.web.info('chat turn completed', { taskId: taskContext?.id, durationMs: Date.now() - turnStartMs })

        // Auto-append to conversation_log if a task was focused
        if (taskContext?.id) {
          autoAppendConversationLog(taskContext.id, message, result.response, [...toolsUsedInTurn]).catch((err) => {
            log.web.warn('autoAppendConversationLog failed', { taskId: taskContext.id, error: err instanceof Error ? err.message : String(err) })
          })
        }

        // Trigger background compaction outside the turn queue.
        // This fires and forgets — the user can send more messages immediately.
        triggerBackgroundCompaction('chat')
      } catch (err) {
        activeAbortControllers.delete(client)
        const errMsg = err instanceof Error ? err.message : String(err)
        log.web.error('chat turn error', { taskId: taskContext?.id, source: 'chat', error: errMsg })

        // Persist user message + synthetic assistant error to maintain role alternation.
        const errorPersistContent = savedImages.length > 0 && Array.isArray(userContent)
          ? replaceImagesWithPaths(
              [{ role: 'user', content: userContent } as MessageParam],
              savedImages,
            )[0]
          : { role: 'user', content: userContent }
        await chatHistory.addAIMessages(
          [
            errorPersistContent as MessageParam,
            { role: 'assistant', content: [{ type: 'text', text: `[Error: ${errMsg}]` }] },
          ] as MessageParam[],
          { displayText: message },
        )
        await chatHistory.addNotification({
          role: 'assistant', content: `Error: ${errMsg}`,
          source: 'agent-error', notification: true,
        })

        // Auto-append to conversation_log for error turns
        if (taskContext?.id) {
          autoAppendConversationLog(taskContext.id, message, `[Error: ${errMsg}]`, [...toolsUsedInTurn]).catch(() => { /* non-critical */ })
        }

        broadcastEvent(EventNames.AGENT_ERROR, { error: errMsg })
      }
    })
  })
}
