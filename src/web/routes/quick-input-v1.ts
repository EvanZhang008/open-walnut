/**
 * /api/v1/quick: the Quick Input box (the Mac app's global hotkey panel, the Alfred workflow,
 * the Raycast script command, the Spotlight action). One short request from anywhere on the Mac,
 * three ways to answer it:
 *
 *   POST /quick/ask   { text, context?, conversation? }  → NDJSON stream
 *        One fast model answer (ai.run's direct route: micro-Claude on the warm pool, or the
 *        main provider's fast model). No task, no session. `{"type":"text","delta"}` lines while
 *        it writes, then one `{"type":"result",text,model?,durationMs,conversation?}` or
 *        `{"type":"error",code,message}` line. The same `conversation` key continues it.
 *   GET  /quick/main                                     → { taskId, sessionId }
 *        Main's task and the session its chat runs on, read only (both null before Main exists).
 *   POST /quick/main  { text, images? }                  → { taskId, sessionId, started, held? }
 *        The text goes into Main's chat as the user's own message (Main is made on first use and
 *        started with it when it has no session). `held`: Main waits on the user's answer to a
 *        prompt, so nothing was sent (a new message would refuse that prompt).
 *        With `follow: true` the answer is an NDJSON stream instead: `{"type":"sent"|"held",
 *        taskId, sessionId, started}`, then Main's reply to THIS message as it is written
 *        (`text` deltas, `activity` lines, one `result` or `error`; quick-main-follow.ts).
 *   POST /quick/task-message { taskId, text, images? }   → { taskId, sessionId, started, held? }
 *        The same for one task found in the list: the text goes into that task's chat as the
 *        user's own message, or starts its session with it when it has none. Fire and forget.
 *        `images` (both sends): up to 5 `{ data: base64, mediaType }`, a screenshot from the
 *        clipboard; saved here and named by path in the message, the phone's way
 *        (session-send-v1.ts). With an image the text may be empty.
 *   POST /quick/session { text, taskId?, images? }       → NDJSON stream, as /quick/main with follow
 *        A normal Claude Code session in Walnut, the Ask Walnut chat's own kind: with no `taskId` a
 *        new ask is started with the text (the phone's New chat, mobile-launch.ts), with the
 *        `taskId` that answer named the text goes into that ask's chat. The reply streams back.
 *   GET  /quick/tasks?q=&limit=&recent=                  → { tasks: [{ id, title, project, state, stateLabel }] }
 *        Tasks matching the words, for the list under the box; with no words and `recent=1`, the
 *        open tasks, the ones needing the user first.
 *   POST /quick/warm                                     → 204
 *        The box opened: boot the quick-answer child now so the first answer skips the CLI boot.
 *
 * Loopback callers need no token (middleware/auth.ts), so a launcher's script reaches it with curl.
 * Primary only: a replica has no AI of the user's and no session runner.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { role } from '../../core/server-role.js'
import { log } from '../../logging/index.js'
import type { SessionRecord, Task } from '../../core/types.js'
import { withImagePaths, type SessionImage } from '../../core/sessions/cloud-images.js'
import { extractValidImages } from './session-send-v1.js'
import { routeSource } from '../../core/sessions/send-sent-by.js'

export const quickInputV1Router = Router()

/** The caller ai.run budgets and logs these answers under (a Walnut feature: no switch, no cap). */
export const QUICK_CALLER = { kind: 'walnut' as const, id: 'quick-input', name: 'Quick Input' }

/** The model the quick answer uses on a Claude Code login (ai-direct.ts CLI_MODEL[quick]). */
const QUICK_EFFORT = 'quick' as const
const QUICK_CLI_MODEL = 'haiku'
const QUICK_TIMEOUT_MS = 45_000
const MAX_TEXT_CHARS = 20_000
const MAX_CONTEXT_CHARS = 60_000
/** ai.run's own rule for a conversation key (core/ai/ai-run.ts), checked before the stream opens. */
const CONVERSATION_KEY = /^[A-Za-z0-9_.:@/-]{1,120}$/

export const QUICK_SYSTEM = [
  "You are Walnut's quick answer box on the user's Mac. The user pressed a hotkey in another app and typed a short request.",
  'Answer in as few words as the request needs. No greeting, no restating the question.',
  'When asked to rewrite, fix, polish, translate, shorten or reply to text, answer with only the new text: no preamble, no quotes around it, no notes after it.',
  'Use Markdown only where it helps (a short list, a code block).',
  'Answer in the language of the request unless it asks for another one; text you rewrite keeps its own language unless asked to translate.',
  "You have no tools: you cannot browse, run anything, or see the user's tasks and files. When a request needs that, say so in one line and suggest Tell Main (Cmd+Enter), Walnut's main agent, which can.",
].join('\n')

/** Only the leader (the Mac) answers: a replica, the companion or a host server, holds a copy. */
function primaryOnly(res: Response): boolean {
  if (role() === 'leader') return true
  res.status(501).json({ error: 'Quick Input answers on your Mac, not on this replica', code: 'not_supported_cloud' })
  return false
}

/** No words: a send of a screenshot alone may carry none. */
function blankText(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && !value.trim())
}

function textOf(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && text.length <= max ? text : null
}

quickInputV1Router.post('/quick/ask', async (req: Request, res: Response) => {
  if (!primaryOnly(res)) return
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>
  const text = textOf(body.text, MAX_TEXT_CHARS)
  if (!text) {
    res.status(400).json({ error: `text must be 1-${MAX_TEXT_CHARS} characters`, code: 'ai_bad_request' })
    return
  }
  if (body.context !== undefined && (typeof body.context !== 'string' || body.context.length > MAX_CONTEXT_CHARS)) {
    res.status(400).json({ error: `context must be text of at most ${MAX_CONTEXT_CHARS} characters`, code: 'ai_bad_request' })
    return
  }
  const context = typeof body.context === 'string' && body.context.trim() ? body.context : undefined
  const conversation = typeof body.conversation === 'string' && body.conversation ? body.conversation : undefined
  if (conversation !== undefined && !CONVERSATION_KEY.test(conversation)) {
    res.status(400).json({ error: 'conversation must be 1-120 letters, digits or _ . : @ / -', code: 'ai_bad_request' })
    return
  }
  const controller = new AbortController()
  // `close` on the response fires when the box closed or a new question replaced this one. The
  // answer stops being waited for; a model child already writing may finish on its own.
  res.on('close', () => { if (!res.writableEnded) controller.abort() })
  res.status(200)
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
  const line = (value: Record<string, unknown>) => { if (!res.writableEnded) res.write(`${JSON.stringify(value)}\n`) }
  try {
    const { aiRun } = await import('../../core/ai/ai-run.js')
    const result = await aiRun(QUICK_CALLER, {
      prompt: text,
      system: QUICK_SYSTEM,
      effort: QUICK_EFFORT,
      timeoutMs: QUICK_TIMEOUT_MS,
      interactive: true,
      ...(context ? { context } : {}),
      ...(conversation ? { conversation } : {}),
      onText: (delta) => line({ type: 'text', delta }),
      signal: controller.signal,
    })
    line({
      type: 'result', text: result.text, durationMs: result.durationMs,
      ...(result.model ? { model: result.model } : {}),
      ...(result.conversation ? { conversation: result.conversation } : {}),
    })
  } catch (error) {
    const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code : 'ai_failed'
    line({ type: 'error', code, message: error instanceof Error ? error.message : String(error) })
  } finally {
    res.end()
  }
})

quickInputV1Router.post('/quick/warm', async (_req: Request, res: Response) => {
  res.status(204).end()
  if (role() !== 'leader') return
  try {
    const [{ getConfig }, { resolveMainProviderName, CLAUDE_CLI_PROVIDER }, { aiDirectOverridden }] = await Promise.all([
      import('../../core/config-manager.js'),
      import('../../model/providers/default-provider.js'),
      import('../../core/ai/ai-direct.js'),
    ])
    if (aiDirectOverridden() || resolveMainProviderName(await getConfig()) !== CLAUDE_CLI_PROVIDER) return
    const { prewarmMicroClaude } = await import('../../providers/micro-claude-warm.js')
    // The exact spec ai-direct.ts runs a quick answer with (warm, partial, no tools), so this child is the one it takes.
    prewarmMicroClaude({ system: QUICK_SYSTEM, model: QUICK_CLI_MODEL, tools: [], partial: true })
  } catch (error) {
    log.web.warn('quick input prewarm failed', { error: error instanceof Error ? error.message : String(error) })
  }
})

/** The session Main's chat runs on, as the web reads it (web/src/utils/session-status.ts resolveTaskSessionId). */
export function mainSessionId(main: Pick<Task, 'session_id' | 'exec_session_id' | 'plan_session_id' | 'session_ids'>): string | null {
  return main.session_id || main.exec_session_id || main.plan_session_id
    || (main.session_ids?.length ? main.session_ids[main.session_ids.length - 1] : null) || null
}

/**
 * The session record Main's chat runs on: the one its task names, else the one a delivery to the
 * task picks (core/routines/session-target.ts), so a task row that lost its pointer still reaches
 * the conversation it has instead of starting it again through the start path's Walnut send.
 */
async function taskSessionRecord(task: Task): Promise<SessionRecord | null> {
  const { getSessionByClaudeId, getSessionsForTask } = await import('../../core/session-tracker.js')
  const named = mainSessionId(task)
  if (named) {
    const record = await getSessionByClaudeId(named)
    if (record && !record.archived) return record
  }
  const { pickDeliverySession } = await import('../../core/routines/session-target.js')
  return pickDeliverySession(await getSessionsForTask(task.id).catch(() => []))
}

quickInputV1Router.get('/quick/main', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (!primaryOnly(res)) return
    const [{ listTasks }] = await Promise.all([import('../../core/task-manager.js')])
    const main = (await listTasks()).find((t) => t.org_role === 'main')
    const record = main ? await taskSessionRecord(main) : null
    res.json({ taskId: main?.id ?? null, sessionId: record?.claudeSessionId ?? null })
  } catch (err) {
    next(err)
  }
})

quickInputV1Router.post('/quick/main', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!primaryOnly(res)) return
    const images = extractValidImages(req.body?.images)
    const text = textOf(req.body?.text, MAX_TEXT_CHARS) ?? (images.length > 0 && blankText(req.body?.text) ? '' : null)
    if (text === null) {
      res.status(400).json({ error: `text must be 1-${MAX_TEXT_CHARS} characters`, code: 'bad_request' })
      return
    }
    if (req.body?.follow === true) {
      await sendAndFollow(() => sendToMain(text, images, quickSource(req)), res)
      return
    }
    const answer = await sendToMain(text, images, quickSource(req))
    delete answer.midTurn
    res.json(answer)
  } catch (err) {
    next(err)
  }
})

/**
 * `follow: true`: one NDJSON stream with the send's outcome, then Main's reply to this message as
 * it is written (quick-main-follow.ts). Closing the request stops the follow, never the turn.
 */
async function sendAndFollow(send: () => Promise<QuickMainResult>, res: Response): Promise<void> {
  res.status(200)
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
  const line = (value: Record<string, unknown>) => { if (!res.writableEnded) res.write(`${JSON.stringify(value)}\n`) }
  const { followMainReply } = await import('./quick-main-follow.js')
  const follower = followMainReply(line, () => { if (!res.writableEnded) res.end() })
  res.on('close', () => follower.stop())
  let sent: QuickMainResult
  try {
    sent = await send()
  } catch (error) {
    line({ type: 'error', code: 'send_failed', message: error instanceof Error ? error.message : String(error) })
    follower.stop()
    return
  }
  line({
    type: sent.held ? 'held' : 'sent', taskId: sent.taskId, sessionId: sent.sessionId, started: sent.started,
    ...(sent.messageId ? { messageId: sent.messageId } : {}),
  })
  if (sent.held || !sent.sessionId) {
    follower.stop()
    return
  }
  follower.bind(sent.sessionId, { messageId: sent.messageId, fresh: sent.started, midTurn: sent.midTurn })
}

quickInputV1Router.post('/quick/session', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!primaryOnly(res)) return
    const images = extractValidImages(req.body?.images)
    const text = textOf(req.body?.text, MAX_TEXT_CHARS) ?? (images.length > 0 && blankText(req.body?.text) ? '' : null)
    if (text === null) {
      res.status(400).json({ error: `text must be 1-${MAX_TEXT_CHARS} characters`, code: 'bad_request' })
      return
    }
    const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId.trim() : ''
    if (taskId) {
      const { getTask } = await import('../../core/task-manager.js')
      const task = await getTask(taskId).catch(() => null)
      if (!task || task.id !== taskId) {
        res.status(404).json({ error: `No task ${taskId}`, code: 'task_not_found' })
        return
      }
      const cliText = await withSavedImages(text, images)
      await sendAndFollow(async () => sendToTaskSession(task, await taskSessionRecord(task), text, cliText, false, quickSource(req)), res)
      return
    }
    await sendAndFollow(() => startAsk(text, images, quickSource(req) === 'ui' ? 'quick-input' : 'api-agent'), res)
  } catch (err) {
    next(err)
  }
})

/** A new ask started with the text: the same task and session the phone's New chat makes. */
async function startAsk(text: string, images: SessionImage[], source: string): Promise<QuickMainResult> {
  const { validateMobileLaunchBody, performMobileLaunch } = await import('../../core/sessions/mobile-launch.js')
  const message = await withSavedImages(text, images)
  const launched = await performMobileLaunch(validateMobileLaunchBody({ walnutAgent: true, message }), source)
  return { taskId: launched.taskId, sessionId: launched.sessionId ?? null, started: true }
}

quickInputV1Router.post('/quick/task-message', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!primaryOnly(res)) return
    const images = extractValidImages(req.body?.images)
    const text = textOf(req.body?.text, MAX_TEXT_CHARS) ?? (images.length > 0 && blankText(req.body?.text) ? '' : null)
    const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId.trim() : ''
    if (text === null || !taskId) {
      res.status(400).json({ error: `taskId and text (1-${MAX_TEXT_CHARS} characters) are required`, code: 'bad_request' })
      return
    }
    const { getTask } = await import('../../core/task-manager.js')
    // An exact id only: the launcher sends the id it listed, and a prefix could reach another task.
    const task = await getTask(taskId).catch(() => null)
    if (!task || task.id !== taskId) {
      res.status(404).json({ error: `No task ${taskId}`, code: 'task_not_found' })
      return
    }
    const answer = await sendToTaskSession(task, await taskSessionRecord(task), text, await withSavedImages(text, images), false, quickSource(req))
    delete answer.midTurn
    res.json(answer)
  } catch (err) {
    next(err)
  }
})

export interface QuickMainResult {
  taskId: string
  sessionId: string | null
  /** True when this message started Main's session. */
  started: boolean
  /** Not sent: Main waits on the user's answer to a prompt in its chat. */
  held?: boolean
  messageId?: string
  /** Main was in a turn when the message went in (quick-main-follow.ts reads the reply after it). */
  midTurn?: boolean
}

/**
 * The user's message into Main's chat (or any task's: sendToTaskSession), the way the Org
 * page's Ask Main sends it
 * (web/src/components/org/ask-main.ts): Main's live session gets it as a person's chat message,
 * with the same message hints a composer send carries; a Main with none is started with it.
 */
export async function sendToMain(text: string, images: SessionImage[] = [], source: string = 'ui'): Promise<QuickMainResult> {
  const { ensureMainTask } = await import('../../core/org/org-store.js')
  const main: Task = await ensureMainTask()
  return sendToTaskSession(main, await taskSessionRecord(main), text, await withSavedImages(text, images), false, source)
}

/**
 * The text the session reads: the saved images' paths first, then the words (its stdin takes
 * text only, so it opens the files with its Read tool). A session on another host gets the files
 * uploaded on the way (RemoteSessionManager.prepareOutbound), for a send and a start alike.
 */
async function withSavedImages(text: string, images: SessionImage[]): Promise<string> {
  if (images.length === 0) return text
  const { saveImageToDisk } = await import('./images.js')
  const paths: string[] = []
  for (const img of images) {
    try {
      paths.push((await saveImageToDisk(img.data, img.mediaType)).filePath)
    } catch (error) {
      log.web.warn('quick input image not saved', { error: error instanceof Error ? error.message : String(error) })
    }
  }
  return paths.length > 0 ? withImagePaths(text, paths) : text
}

/** A person's send source, unless a session made the request (an agent calling this route is not a person). */
function quickSource(req: Request): string {
  return routeSource('ui', req.headers)
}

/** The person's message into one task's chat: its live session, or a session started with it. */
export async function sendToTaskChat(task: Task, text: string, source: string = 'ui'): Promise<QuickMainResult> {
  return sendToTaskSession(task, await taskSessionRecord(task), text, text, false, source)
}

async function sendToTaskSession(task: Task, record: SessionRecord | null, text: string, cliText: string, startedOnce = false, source: string = 'ui'): Promise<QuickMainResult> {
  if (record) {
    const sessionId = record.claudeSessionId
    if (record.pendingPermission && (record.process_status === 'running' || record.process_status === 'idle')) {
      return { taskId: task.id, sessionId, started: false, held: true }
    }
    const [{ prepareHintedSend }, { sendMessageToSession }] = await Promise.all([
      import('../../core/hints/hint-send.js'),
      import('../../core/session-message-queue.js'),
    ])
    const hinted = await prepareHintedSend(sessionId, record, cliText, { sentBy: source === 'ui' ? 'person' : 'agent' })
    const msg = await sendMessageToSession(sessionId, text, {
      source,
      taskId: task.id,
      ...(hinted.enqueueText !== text ? { enqueueMessage: hinted.enqueueText } : {}),
      hinted: true,
    })
    await hinted.commit()
    log.web.info('quick input sent to task', { taskId: task.id, sessionId, messageId: msg.id })
    return { taskId: task.id, sessionId, started: false, messageId: msg.id, midTurn: record.process_status === 'running' }
  }
  const { startSessionForTask, SessionExistsError } = await import('../../core/sessions/task-start.js')
  let started
  try {
    started = await startSessionForTask({ taskIdPrefix: task.id, message: cliText, source: source === 'ui' ? 'api-v1' : source })
  } catch (err) {
    // A session the task row did not name (a start that won the race): the message goes to it.
    if (err instanceof SessionExistsError && err.existingSessionId && !startedOnce) {
      const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
      const existing = await getSessionByClaudeId(err.existingSessionId)
      if (existing) return sendToTaskSession(task, existing, text, cliText, true, source)
    }
    throw err
  }
  const startedSid = started.sessionId ?? null
  log.web.info('quick input started task', { taskId: task.id, sessionId: startedSid })
  // `continued`: the task's conversation took it (one-session-per-task.ts), not a new session.
  return { taskId: task.id, sessionId: startedSid, started: !started.continued }
}

quickInputV1Router.get('/quick/tasks', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!primaryOnly(res)) return
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : ''
    const asked = Number(req.query.limit)
    const limit = Number.isFinite(asked) ? Math.max(1, Math.min(20, Math.floor(asked))) : 6
    if (!q) {
      // `recent`: the open tasks to offer before any words (the Spotlight action's task picker).
      res.json({ tasks: req.query.recent === '1' ? await recentQuickTasks(limit) : [] })
      return
    }
    res.json({ tasks: await quickTasks(q, limit) })
  } catch (err) {
    next(err)
  }
})

export interface QuickTaskRow {
  id: string
  title: string
  project: string
  state: string
  stateLabel: string
}

/** Tasks matching the words, best first, open ones before finished ones. */
const STATE_RANK: Record<string, number> = { needs: 0, working: 1, waiting: 2, done: 3 }

/** Open board tasks, the ones needing the user first, then the most recently changed. */
export async function recentQuickTasks(limit: number): Promise<QuickTaskRow[]> {
  const [{ listTasks }, { USER_STATE_LABELS, fallbackUserState }] = await Promise.all([
    import('../../core/task-manager.js'),
    import('../../core/user-status.js'),
  ])
  return (await listTasks())
    // What the board shows: no plugin's own task (test runs included), not Main or a lead.
    .filter((t) => t.phase !== 'COMPLETE' && !t.plugin_only && !t.org_role)
    .map((task) => ({ task, state: task.user_status?.state ?? fallbackUserState(task.phase) }))
    .sort((a, b) => (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9)
      || String(b.task.updated_at ?? '').localeCompare(String(a.task.updated_at ?? '')))
    .slice(0, limit)
    .map(({ task, state }) => ({ id: task.id, title: task.title, project: task.project ?? '', state, stateLabel: USER_STATE_LABELS[state] }))
}

export async function quickTasks(q: string, limit: number): Promise<QuickTaskRow[]> {
  const [{ search }, { getTask }, { USER_STATE_LABELS, fallbackUserState }] = await Promise.all([
    import('../../core/search.js'),
    import('../../core/task-manager.js'),
    import('../../core/user-status.js'),
  ])
  // A typing-speed list: the keyword lanes answer at once, the semantic lane gets a short wait.
  const hits = await search(q, { types: ['task'], limit: limit * 2, semanticDeadlineMs: 150 })
  const seen = new Set<string>()
  const rows: QuickTaskRow[] = []
  for (const hit of hits) {
    const id = hit.taskId
    if (!id || seen.has(id)) continue
    seen.add(id)
    const task = await getTask(id).catch(() => null)
    if (!task) continue
    const state = task.user_status?.state ?? fallbackUserState(task.phase)
    rows.push({ id: task.id, title: task.title, project: task.project ?? '', state, stateLabel: USER_STATE_LABELS[state] })
  }
  const open = rows.filter((r) => r.state !== 'done')
  const done = rows.filter((r) => r.state === 'done')
  return [...open, ...done].slice(0, limit)
}
