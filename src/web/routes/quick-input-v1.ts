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
 *        (`delivered` once its session takes it, `text` deltas, `activity` lines, one `result` or
 *        `error`; quick-main-follow.ts).
 *   POST /quick/task-message { taskId, text, images? }   → { taskId, sessionId, started, held? }
 *        The same for one task found in the list: the text goes into that task's chat as the
 *        user's own message, or starts its session with it when it has none. Fire and forget.
 *        `images` (both sends): up to 5 `{ data: base64, mediaType }`, a screenshot from the
 *        clipboard; saved here and named by path in the message, the phone's way
 *        (session-send-v1.ts). With an image the text may be empty.
 *        Both are the one send below.
 *   POST /quick/send { to?, text, images?, follow?, userUuid?, resend? } → as /quick/main
 *        The quick bar's send (web/src/components/quickbar/): `to` is the task id the people list
 *        named (a VP, any task), Main when absent or `ceo`; `follow` streams that task's reply.
 *        `userUuid` (a v4 uuid the client made for this send) is the send's own user line: the
 *        same uuid again is that send, never a second copy (core/sessions/send-once.ts), answered
 *        as the first was, or as `delivered` when its line already ran. `resend`: `auto` (the bar
 *        sends it again by itself once Walnut answers) or `person` (its Send again).
 *        In a focus space (experiment focus_workspace) a line to anyone outside it is dropped out
 *        and left: after `sent` the stream ends with `{ type: 'kept', reason: 'outside_focus' }`,
 *        and the reply waits in that chat, never streaming back into the focus.
 *   GET  /quick/people?limit=                            → { people: [{ id, title, kind, state, line, needs, ... }], focus? }
 *        Who the bar can talk to: CEO, every VP, then open tasks, needing the user first (quick-people.ts).
 *        In a focus space, only its tasks, and `focus: { name, outside }` counts the rest.
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
import { routeSource, startRouteSource } from '../../core/sessions/send-sent-by.js'

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
  "You have no tools: you cannot browse, run anything, or see the user's tasks and files. When a request needs that, say so in one line and suggest Tell CEO (Cmd+Enter), Walnut's main agent, which can.",
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
    await quickSend(req, res, null, `text must be 1-${MAX_TEXT_CHARS} characters`)
  } catch (err) {
    next(err)
  }
})

/** The quick bar's one send: `to` names the task (a VP, any task), Main when absent or `ceo`. */
quickInputV1Router.post('/quick/send', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!primaryOnly(res)) return
    const to = typeof req.body?.to === 'string' ? req.body.to.trim() : ''
    const toMain = !to || to.toLowerCase() === 'ceo' || to.toLowerCase() === 'main'
    // A line dropped out of a focus space never brings its reply back into it.
    const kept = req.body?.follow === true && await leavesFocus(toMain ? null : to).catch(() => false)
    await quickSend(req, res, toMain ? null : to, `text must be 1-${MAX_TEXT_CHARS} characters`, { testRunGuard: true, kept })
  } catch (err) {
    next(err)
  }
})

/** The person is in a focus space and this line goes outside it (Main included). Never throws. */
async function leavesFocus(taskId: string | null): Promise<boolean> {
  const { focusSpacesFlag } = await import('../../core/focus-spaces/flag.js')
  if (!(await focusSpacesFlag.on())) return false
  const { getActiveFocus } = await import('../../core/focus-spaces/active.js')
  const active = await getActiveFocus().catch(() => null)
  if (!active) return false
  if (taskId === null) return true
  const [{ taskInScope }, { scopeTaskLookup }] = await Promise.all([
    import('../../core/focus-spaces/scope.js'),
    import('../../core/task-manager.js'),
  ])
  return !taskInScope(active.scope, taskId, await scopeTaskLookup())
}

/**
 * One send for every quick box: the text (and screenshots) into Main's chat (`taskId` null) or one
 * task's, as the user's own message; `follow: true` streams the reply to it (sendAndFollow).
 */
async function quickSend(req: Request, res: Response, taskId: string | null, badRequest: string, opts: { testRunGuard?: boolean; kept?: boolean } = {}): Promise<void> {
  const images = extractValidImages(req.body?.images)
  const text = textOf(req.body?.text, MAX_TEXT_CHARS) ?? (images.length > 0 && blankText(req.body?.text) ? '' : null)
  if (text === null || taskId === '') {
    res.status(400).json({ error: badRequest, code: 'bad_request' })
    return
  }
  const line = quickLineOf(req.body)
  if (line === null) {
    res.status(400).json({ error: 'userUuid must be a v4 UUID string', code: 'bad_request' })
    return
  }
  let send: () => Promise<QuickMainResult>
  if (taskId === null) {
    // A marked test run talks to its own stand-in CEO, never the user's (content-v1.ts).
    const standIn = opts.testRunGuard ? await (await import('./content-v1.js')).testRunCeo() : null
    send = standIn ? () => sendToTaskFromRequest(req, standIn, text, images, line) : () => sendToMain(text, images, quickSource(req), line)
  } else {
    const task = await exactTask(taskId, res)
    if (!task) return
    if (opts.testRunGuard && task.org_role && task.org_role !== 'main' && (await import('../../core/test-run.js')).ambientTestRun()) {
      res.status(409).json({ error: 'A test run never writes into a VP or router chat', code: 'test_run_unmarked' })
      return
    }
    send = () => sendToTaskFromRequest(req, task, text, images, line)
  }
  if (line) {
    // The same send again (the bar resends by itself once Walnut answers) is that send, run once.
    // The key names the target too: the same uuid to another task is never answered as the first.
    const first = send
    const { sendOnce } = await import('../../core/sessions/send-once.js')
    const source = quickSource(req)
    // A held answer sent nothing (a permission prompt stands in the way): never kept, so the same
    // line again tries again instead of being told "held" for eleven minutes.
    send = () => sendOnce(`quick\n${taskId ?? 'main'}\n${line.userUuid}`, first, {
      again: (answer) => wentInSince(answer, line, text, source), keep: (a) => !a.held,
    })
  }
  if (req.body?.follow === true) {
    await sendAndFollow(send, res, { kept: opts.kept })
    return
  }
  // A copy: the kept answer of a send (send-once.ts) is answered again as it was.
  const { midTurn: _midTurn, ...answer } = await send()
  res.json(answer)
}

/**
 * `follow: true`: one NDJSON stream with the send's outcome, then Main's reply to this message as
 * it is written (quick-main-follow.ts). Closing the request stops the follow, never the turn.
 */
async function sendAndFollow(send: () => Promise<QuickMainResult>, res: Response, opts: { kept?: boolean } = {}): Promise<void> {
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
  // A resend of a line that already ran: delivered, and its reply (if any) is in its chat.
  if (sent.alreadyDelivered) line({ type: 'delivered' })
  if (sent.held || !sent.sessionId || sent.alreadyDelivered) {
    follower.stop()
    return
  }
  if (opts.kept) {
    line({ type: 'kept', reason: 'outside_focus' })
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
      const task = await exactTask(taskId, res)
      if (!task) return
      await sendAndFollow(() => sendToTaskFromRequest(req, task, text, images), res)
      return
    }
    await sendAndFollow(() => startAsk(text, images, startRouteSource('quick-input', req.headers), startingSid(req)), res)
  } catch (err) {
    next(err)
  }
})

/** A new ask started with the text: the same task and session the phone's New chat makes. */
async function startAsk(text: string, images: SessionImage[], source: string, callerSid?: string): Promise<QuickMainResult> {
  const { validateMobileLaunchBody, performMobileLaunch } = await import('../../core/sessions/mobile-launch.js')
  const message = await withSavedImages(text, images)
  const launched = await performMobileLaunch(validateMobileLaunchBody({ walnutAgent: true, message }), source, callerSid ? { callerSid } : {})
  return { taskId: launched.taskId, sessionId: launched.sessionId ?? null, started: true }
}

quickInputV1Router.post('/quick/task-message', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!primaryOnly(res)) return
    const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId.trim() : ''
    await quickSend(req, res, taskId, `taskId and text (1-${MAX_TEXT_CHARS} characters) are required`)
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
  /** A resend whose line already ran (send-once.ts): nothing was sent again. */
  alreadyDelivered?: boolean
}

/**
 * The first answer of a send asked again: its queued row may have gone in since, and then the
 * reply to follow is over or under way; the client hears it was delivered (the reply is in its chat).
 * A row still queued is asked to go now, as the chat's resend does (send-once.ts sameSendSettled):
 * a person's Send again also releases it from a park, the bar's own resend never does.
 */
async function wentInSince(answer: QuickMainResult, line: QuickLine, text: string, source: string): Promise<QuickMainResult> {
  if (!answer.messageId || answer.held || answer.alreadyDelivered) return answer
  const { findQueuedMessage } = await import('../../core/session-message-queue.js')
  if (!(await findQueuedMessage(answer.messageId))) return { ...answer, alreadyDelivered: true }
  if (line.resend && answer.sessionId) {
    const { sendQueuedNow } = await import('../../core/sessions/send-now.js')
    await sendQueuedNow({
      sessionId: answer.sessionId, messageId: answer.messageId, taskId: answer.taskId, message: text, source, unpark: line.resend === 'person',
    })
  }
  return answer
}

/** A quick send's own user line (`userUuid`) and whether this is it sent again. */
interface QuickLine { userUuid: string; resend?: 'auto' | 'person' }

/** v4 only: the uuid becomes the CLI's own user line, as session:send's (session-chat.ts). */
const V4_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** The body's line: undefined without one (older clients), null for a malformed one. */
function quickLineOf(body: unknown): QuickLine | undefined | null {
  const b = (body ?? {}) as { userUuid?: unknown; resend?: unknown }
  if (b.userUuid === undefined) return undefined
  if (typeof b.userUuid !== 'string' || b.userUuid.length > 36 || !V4_UUID_RE.test(b.userUuid)) return null
  return { userUuid: b.userUuid, ...(b.resend === 'auto' || b.resend === 'person' ? { resend: b.resend } : {}) }
}

/**
 * The user's message into Main's chat (or any task's: sendToTaskSession), the way the Org
 * page's Ask Main sends it
 * (web/src/components/org/ask-main.ts): Main's live session gets it as a person's chat message,
 * with the same message hints a composer send carries; a Main with none is started with it.
 */
export async function sendToMain(text: string, images: SessionImage[] = [], source: string = 'ui', line?: QuickLine): Promise<QuickMainResult> {
  const { ensureMainTask } = await import('../../core/org/org-store.js')
  const main: Task = await ensureMainTask()
  return sendToTaskSession(main, await taskSessionRecord(main), text, await withSavedImages(text, images), false, source, source, undefined, line)
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
export async function sendToTaskChat(task: Task, text: string, source: string = 'ui', images: SessionImage[] = []): Promise<QuickMainResult> {
  return sendToTaskSession(task, await taskSessionRecord(task), text, await withSavedImages(text, images), false, source)
}

/**
 * The task a quick send names, by its exact id only (the launcher sends the id it listed, and a
 * prefix could reach another task); answers 404 itself and gives null when there is none.
 */
async function exactTask(taskId: string, res: Response): Promise<Task | null> {
  const { getTask } = await import('../../core/task-manager.js')
  const task = await getTask(taskId).catch(() => null)
  if (task && task.id === taskId) return task
  res.status(404).json({ error: `No task ${taskId}`, code: 'task_not_found' })
  return null
}

/** The words into one task's chat as this request's: its source, its start's source and caller. */
async function sendToTaskFromRequest(req: Request, task: Task, text: string, images: SessionImage[], line?: QuickLine): Promise<QuickMainResult> {
  return sendToTaskSession(task, await taskSessionRecord(task), text, await withSavedImages(text, images), false, quickSource(req), startRouteSource('api-v1', req.headers), startingSid(req), line)
}

/** The session making this request: a task it starts here runs at most as loose as it (delegated-mode.ts). */
function startingSid(req: Request): string | undefined {
  return req.get('x-walnut-caller-sid')?.trim() || undefined
}

async function sendToTaskSession(task: Task, record: SessionRecord | null, text: string, cliText: string, startedOnce = false, source: string = 'ui', firstSource = source, callerSid?: string, line?: QuickLine): Promise<QuickMainResult> {
  if (record) {
    const sessionId = record.claudeSessionId
    if (line?.resend) {
      // Sent again after a lost answer (this process may have restarted): its row or its line is it.
      const { sameSendSettled } = await import('../../core/sessions/send-once.js')
      const same = await sameSendSettled({
        sessionId, host: record.host, taskId: task.id, userUuid: line.userUuid, message: text, source, autoResend: line.resend === 'auto',
      })
      if (same.state === 'queued') return { taskId: task.id, sessionId, started: false, messageId: same.messageId, midTurn: record.process_status === 'running' }
      if (same.state === 'ran') return { taskId: task.id, sessionId, started: false, alreadyDelivered: true }
    }
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
      // The queue row carries the send's own user line; the drain hands it to the CLI.
      ...(line ? { userUuid: line.userUuid } : {}),
    })
    await hinted.commit()
    log.web.info('quick input sent to task', { taskId: task.id, sessionId, messageId: msg.id })
    return { taskId: task.id, sessionId, started: false, messageId: msg.id, midTurn: record.process_status === 'running' }
  }
  const { startSessionForTask, SessionExistsError } = await import('../../core/sessions/task-start.js')
  let started
  try {
    // The first line goes out under the send's own uuid, so the same send again after a restart
    // finds the line it started the session with (send-once.ts sameSendSettled) and is not sent twice.
    started = await startSessionForTask({
      taskIdPrefix: task.id, message: cliText, source: firstSource === 'ui' ? 'api-v1' : firstSource, callerSid,
      ...(line ? { firstLineUuid: line.userUuid } : {}),
    })
  } catch (err) {
    // A session the task row did not name (a start that won the race): the message goes to it.
    if (err instanceof SessionExistsError && err.existingSessionId && !startedOnce) {
      const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
      const existing = await getSessionByClaudeId(err.existingSessionId)
      if (existing) return sendToTaskSession(task, existing, text, cliText, true, source, firstSource, callerSid, line)
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
    const { recentQuickTasks, quickTasks } = await import('./quick-people.js')
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

quickInputV1Router.get('/quick/people', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!primaryOnly(res)) return
    const asked = Number(req.query.limit)
    const limit = Number.isFinite(asked) ? Math.max(0, Math.min(30, Math.floor(asked))) : 12
    const { quickPeople, focusPeople } = await import('./quick-people.js')
    // In a focus space: its tasks only, the rest counted (`focus: { name, outside }`).
    res.json(await focusPeople(await quickPeople(limit)))
  } catch (err) {
    next(err)
  }
})
