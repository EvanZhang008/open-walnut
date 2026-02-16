/**
 * Chat route — bridges WebSocket RPC to the agent loop.
 *
 * Server is the source of truth for conversation history.
 * Client sends only { message }, server loads history from ChatHistoryManager,
 * runs the agent loop, and persists the new turn to disk.
 */

import type { WebSocket } from 'ws'
import type { MessageParam } from '../../agent/model.js'
import type { DisplayMessageBlock } from '../../core/types.js'
import type { CompactionResult } from '../../core/chat-history.js'
import { MEMORY_FLUSH_MESSAGE } from '../../core/chat-history.js'
import { registerMethod, sendToClient } from '../ws/handler.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { usageTracker } from '../../core/usage/index.js'
import * as chatHistory from '../../core/chat-history.js'
import { drainPendingCronNotifications } from '../server.js'
import { getTask, appendConversationLog } from '../../core/task-manager.js'
import { getSessionByClaudeId } from '../../core/session-tracker.js'
import { saveImageToDisk } from './images.js'
import { compressForApi } from '../../utils/image-compress.js'
import { log } from '../../logging/index.js'
import { enqueueMainAgentTurn } from '../agent-turn-queue.js'
import { triggerBackgroundCompaction } from '../background-compaction.js'

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

interface ImagePayload {
  data: string       // raw base64
  mediaType: string  // 'image/png', 'image/jpeg', etc.
}

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_IMAGES_PER_MESSAGE = 5

interface ChatPayload {
  message: string
  taskContext?: TaskContext
  images?: ImagePayload[]
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

/**
 * Fire-and-forget helper: append a conversation log entry to a task after a chat turn.
 * Truncates user/AI messages to keep entries brief. appendConversationLog auto-prepends the timestamp.
 */
async function autoAppendConversationLog(taskId: string, userMessage: string, aiResponse: string, toolNames?: string[]): Promise<void> {
  const userSummary = userMessage.length > 150
    ? userMessage.slice(0, 150).trim() + '\u2026'
    : userMessage

  let aiSummary: string
  if (aiResponse) {
    aiSummary = aiResponse.length > 200
      ? aiResponse.slice(0, 200).trim() + '\u2026'
      : aiResponse
  } else if (toolNames && toolNames.length > 0) {
    aiSummary = `[Used tools: ${toolNames.join(', ')}]`
  } else {
    aiSummary = '[No response]'
  }

  const entry = `**User:** ${userSummary}\n**AI:** ${aiSummary}`
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
      } catch {
        taskLabels.set(id, id)
      }
    }),
    ...Array.from(sessionIds).map(async (id) => {
      try {
        const session = await getSessionByClaudeId(id)
        sessionLabels.set(id, session?.title || id)
      } catch {
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
  })

  registerMethod('chat', async (payload: unknown, client: WebSocket) => {
    const { message, taskContext, images } = payload as ChatPayload
    log.web.info('chat message received', { taskId: taskContext?.id, messageLength: message.length, imageCount: images?.length ?? 0, source: 'chat' })

    // Pre-process images outside the queue (save to disk, prepare base64 blocks).
    // This avoids holding the queue while doing disk I/O for image uploads.
    const contextPrefix = taskContext ? buildTaskContextPrefix(taskContext) : ''

    let savedImages: Array<{ filePath: string; filename: string; mediaType: string }> = []
    let imageContentBlocks: unknown[] | null = null
    if (images && images.length > 0) {
      const validImages = images
        .filter(img => ALLOWED_IMAGE_TYPES.has(img.mediaType))
        .filter(img => !!img.data)
        .slice(0, MAX_IMAGES_PER_MESSAGE)
      if (validImages.length > 0) {
        const saved = await Promise.all(
          validImages.map(async (img) => {
            const rawBuffer = Buffer.from(img.data, 'base64')
            const { buffer, mimeType } = await compressForApi(rawBuffer, img.mediaType)
            const compressedBase64 = buffer.toString('base64')
            const { filePath, filename } = await saveImageToDisk(compressedBase64, mimeType)
            return { filePath, filename, mediaType: mimeType, data: compressedBase64 }
          }),
        )
        savedImages = saved.map(s => ({ filePath: s.filePath, filename: s.filename, mediaType: s.mediaType }))
        imageContentBlocks = saved.map(s => ({
          type: 'image',
          source: { type: 'base64', media_type: s.mediaType, data: s.data },
        }))
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
        const imagePathLines = savedImages.map((s, i) => `Image ${i + 1}: ${s.filePath}`).join('\n')
        const imageAnnotation = `<attached-images>\n${imagePathLines}\n</attached-images>\n\n`
        imageContentBlocks.push({ type: 'text', text: imageAnnotation + agentMessage })
        userContent = imageContentBlocks
      }

      const turnStartMs = Date.now()
      const toolsUsedInTurn = new Set<string>()
      try {
        const result = await runAgentLoop(userContent, history, {
          onTextDelta: (delta) => {
            sendToClient(client, EventNames.AGENT_TEXT_DELTA, { delta })
          },
          onToolActivity: (activity) => {
            sendToClient(client, EventNames.AGENT_TOOL_ACTIVITY, activity)
          },
          onThinking: (text) => {
            sendToClient(client, EventNames.AGENT_THINKING, { text })
          },
          onToolCall: (toolName, input) => {
            toolsUsedInTurn.add(toolName)
            sendToClient(client, EventNames.AGENT_TOOL_CALL, { toolName, input })
          },
          onToolResult: (toolName, result) => {
            sendToClient(client, EventNames.AGENT_TOOL_RESULT, { toolName, result })
          },
          onUsage: (usage) => {
            bus.emit('agent:usage', { usage }, ['web-ui'], { source: 'agent' })
            try { usageTracker.record({ source: 'agent', model: usage.model ?? 'unknown', input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens }) } catch {}
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
            await chatHistory.addAIMessages(persistMsgs, { displayText: message })
          }
          // Auto-append to conversation_log for aborted turns
          if (taskContext?.id) {
            autoAppendConversationLog(taskContext.id, message, result.response || '[Aborted]', [...toolsUsedInTurn]).catch((err) => {
              log.web.warn('autoAppendConversationLog failed (aborted)', { taskId: taskContext.id, error: err instanceof Error ? err.message : String(err) })
            })
          }
          sendToClient(client, EventNames.AGENT_RESPONSE, { text: result.response, aborted: true })
          return
        }

        // Extract the new messages added during this turn
        const newApiMsgs = result.messages.slice(history.length) as MessageParam[]

        // Resolve entity refs before persisting
        const resolvedMsgs = await resolveMessagesEntityRefs(newApiMsgs)
        const resolvedText = await resolveEntityRefs(result.response)

        // Replace base64 image blocks with path-based blocks before persisting
        const persistMsgs = replaceImagesWithPaths(resolvedMsgs, savedImages)

        // Persist to disk
        await chatHistory.addAIMessages(persistMsgs, { displayText: message })
        log.agent.info('agent response persisted', { taskId: taskContext?.id, messageCount: newApiMsgs.length })

        // Signal turn complete to the client (resets isStreaming).
        // This resolves the RPC immediately — compaction runs separately below.
        sendToClient(client, EventNames.AGENT_RESPONSE, { text: resolvedText })
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

        sendToClient(client, EventNames.AGENT_ERROR, { error: errMsg })
      }
    })
  })
}
