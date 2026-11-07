/**
 * /api/v1/triage/routing-rules — Inbox Triage's standing routing rules (core/triage/routing-rules.ts).
 *
 *   GET    /triage/routing-rules             → { rules }  (each with its task's live title and phase)
 *   POST   /triage/routing-rules             { from?, subject?, task_id, note?, enabled? } → 201 { rule }
 *   PATCH  /triage/routing-rules/:id         same fields, each optional → { rule }
 *   DELETE /triage/routing-rules/:id         → { deleted }
 *   POST   /triage/routing-rules/:id/route   { item, text, source? } → 202 { rule, delivered }
 *
 * Writers (the brief, 2026-11-05: "a person and any VP or Main"): a request with no
 * `x-walnut-caller-sid` is a person's; a session's is Main's or a VP's (its task's `org_role` is
 * main or lead), anyone else gets 403 `routing_rule_writer` naming who can. `route` is the run's
 * hand-off, open to any session: it sends to the rule's task through the one send path
 * (session-send-core.ts), with the rule named on the message.
 *
 * Primary only: the rules ride the data hub to a replica as a file, and a replica writes none.
 * A test run on a real server writes none either: a rule would change what every real triage
 * run does with the user's mail (test-run.ts).
 */
import { Router, type NextFunction, type Request, type Response } from 'express'
import { WALNUT_HOME } from '../../constants.js'
import { role as serverRole } from '../../core/server-role.js'
import { log } from '../../logging/index.js'
import { sendV1Error as sendError } from './v1-control-relay.js'
import {
  deleteRoutingRule, noteRoutedItem, readRoutingRules, ruleMatchText, RoutingRuleError, setRoutingRule,
  type RoutingRuleAuthor, type RoutingRuleInput, type TriageRoutingRule,
} from '../../core/triage/routing-rules.js'

export const triageRulesV1Router = Router()

const BASE = '/triage/routing-rules'

function header(req: Request, name: string): string | undefined {
  const raw = req.headers[name]
  const v = (Array.isArray(raw) ? raw[0] : raw ?? '').trim()
  return v || undefined
}

function body(req: Request): Record<string, unknown> {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {}
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

interface TaskLook { id: string; title: string; phase: string; org_role?: string; triage?: boolean }

async function taskOf(id: string): Promise<TaskLook | null> {
  try {
    const { getTask } = await import('../../core/task-manager.js')
    const t = await getTask(id)
    const { isTriageLetterSender } = await import('../../core/human-inbox/letter-origin.js')
    const triage = isTriageLetterSender({ sessionId: '', host: '', taskId: t.id, agentId: t.agent_id, project: t.project })
    return { id: t.id, title: t.title, phase: t.phase, ...(t.org_role ? { org_role: t.org_role } : {}), ...(triage ? { triage } : {}) }
  } catch {
    return null
  }
}

/** The caller's task, or null for a person (no session header). */
async function callerTask(req: Request): Promise<{ sid: string; task: TaskLook | null } | null> {
  const sid = header(req, 'x-walnut-caller-sid')
  if (!sid) return null
  const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
  const record = await getSessionByClaudeId(sid).catch(() => null)
  return { sid, task: record?.taskId ? await taskOf(record.taskId) : null }
}

/** Who may write: a person, Main, or a VP; null when allowed, else the refusal sent. */
async function writer(req: Request, res: Response): Promise<RoutingRuleAuthor | null> {
  if (serverRole() === 'replica') {
    sendError(res, 501, 'not_supported_cloud', 'Routing rules are written on the primary box')
    return null
  }
  const { ambientTestRun } = await import('../../core/test-run.js')
  if (ambientTestRun()) {
    sendError(res, 409, 'test_run', 'A test run writes no routing rules: a rule changes what every real Inbox Triage run does with the user\'s mail.')
    return null
  }
  const caller = await callerTask(req)
  if (!caller) return { by: 'human' }
  const role = caller.task?.org_role
  if (caller.task && (role === 'main' || role === 'lead')) {
    return { by: 'task', taskId: caller.task.id, name: caller.task.title }
  }
  sendError(res, 403, 'routing_rule_writer', caller.task?.triage
    // A triage run is where the user most often says "mail about X goes to task Y" (2026-11-05).
    ? 'Routing rules are written by the user, Main or a VP. Pass the user\'s words to Main (org_send), '
      + 'naming the sender or subject and the task the items go to, and tell the user it is on its way; '
      + 'they can also add it in Settings > Inbox Triage > Routing rules.'
    : 'Routing rules are written by the user, Main or a VP. Ask your lead (or Main) to add this rule, '
      + 'naming the sender or subject and the task the items go to.')
  return null
}

function inputOf(b: Record<string, unknown>): RoutingRuleInput {
  return {
    ...(str(b.from) !== undefined ? { from: str(b.from) } : {}),
    ...(str(b.subject) !== undefined ? { subject: str(b.subject) } : {}),
    ...(str(b.task_id ?? b.taskId) !== undefined ? { taskId: str(b.task_id ?? b.taskId) } : {}),
    ...(str(b.note) !== undefined ? { note: str(b.note) } : {}),
    ...(typeof b.enabled === 'boolean' ? { enabled: b.enabled } : {}),
    ...(typeof b.position === 'number' ? { position: b.position } : {}),
  }
}

/** A rule as the API answers it: its task's live title and phase beside the stored ones. */
async function view(rule: TriageRoutingRule): Promise<TriageRoutingRule & { task: TaskLook | null; matchText: string }> {
  const task = await taskOf(rule.taskId)
  return { ...rule, ...(task ? { taskTitle: task.title } : {}), task, matchText: ruleMatchText(rule) }
}

function routingError(res: Response, err: unknown): boolean {
  if (err instanceof RoutingRuleError) {
    sendError(res, err.status, err.code, err.message)
    return true
  }
  return false
}

triageRulesV1Router.get(BASE, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rules = await readRoutingRules(WALNUT_HOME)
    res.json({ rules: await Promise.all(rules.map(view)) })
  } catch (err) { if (!routingError(res, err)) next(err) }
})

async function write(req: Request, res: Response, id: string | undefined): Promise<void> {
  const author = await writer(req, res)
  if (!author) return
  const b = body(req)
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') {
    sendError(res, 400, 'bad_request', '`enabled` is true or false.')
    return
  }
  const input = inputOf(b)
  const rules = await readRoutingRules(WALNUT_HOME)
  const current = id ? rules.find((r) => r.id === id) : undefined
  if (id && !current) {
    sendError(res, 404, 'not_found', `No routing rule ${id}`)
    return
  }
  // `before: <rule id>` places it right above that rule, resolved here against the file as it is.
  const before = str(b.before)
  if (before) {
    const at = rules.filter((r) => r.id !== id).findIndex((r) => r.id === before)
    if (at < 0) {
      sendError(res, 404, 'not_found', `No routing rule ${before} to place it before`)
      return
    }
    input.position = at
  }
  // The rule's own task again (a writer resending the whole rule) is no change: a task that
  // completed or went since keeps its rule editable.
  if (input.taskId !== undefined && input.taskId === current?.taskId) {
    delete input.taskId
  } else if (input.taskId !== undefined) {
    const task = await taskOf(input.taskId)
    if (!task) {
      sendError(res, 400, 'unknown_task', `No task ${input.taskId}: a routing rule sends items to an existing task.`)
      return
    }
    if (task.phase === 'COMPLETE') {
      sendError(res, 409, 'task_complete', `Task "${task.title}" is complete: a routing rule sends items to open work. Reopen it or pick another task.`)
      return
    }
    input.taskId = task.id
    input.taskTitle = task.title
  }
  try {
    const rule = await setRoutingRule(WALNUT_HOME, { ...input, ...(id ? { id } : {}) }, author)
    log.web.info('triage routing rule written', { ruleId: rule.id, taskId: rule.taskId, by: author.by, byTask: author.taskId, created: !id })
    res.status(id ? 200 : 201).json({ rule: await view(rule) })
  } catch (err) {
    if (!routingError(res, err)) throw err
  }
}

triageRulesV1Router.post(BASE, async (req: Request, res: Response, next: NextFunction) => {
  try { await write(req, res, undefined) } catch (err) { if (!routingError(res, err)) next(err) }
})

triageRulesV1Router.patch(`${BASE}/:id`, async (req: Request, res: Response, next: NextFunction) => {
  try { await write(req, res, String(req.params.id ?? '')) } catch (err) { if (!routingError(res, err)) next(err) }
})

triageRulesV1Router.delete(`${BASE}/:id`, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const author = await writer(req, res)
    if (!author) return
    const id = String(req.params.id ?? '')
    const deleted = await deleteRoutingRule(WALNUT_HOME, id)
    if (!deleted) {
      sendError(res, 404, 'not_found', `No routing rule ${id}`)
      return
    }
    log.web.info('triage routing rule deleted', { ruleId: id, by: author.by, byTask: author.taskId })
    res.json({ deleted: true })
  } catch (err) { if (!routingError(res, err)) next(err) }
})

/** The words the routed task reads first: which rule sent the item, and how to change it. */
export function routedHeader(rule: Pick<TriageRoutingRule, 'id' | 'match'>): string {
  return `Inbox Triage routed this item to you by routing rule ${rule.id} (${ruleMatchText(rule)}). `
    + 'You own it from here; the user, Main or a VP can change the rule in Settings > Inbox Triage.'
}

triageRulesV1Router.post(`${BASE}/:id/route`, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (serverRole() === 'replica') {
      sendError(res, 501, 'not_supported_cloud', 'Session sends run on the primary box')
      return
    }
    // A test run on a real server routes nothing: the send would land in a real task.
    const { ambientTestRun } = await import('../../core/test-run.js')
    if (ambientTestRun()) {
      sendError(res, 409, 'test_run', 'A test run routes no items: the send would reach one of the user\'s real tasks.')
      return
    }
    // The routed task reads "Inbox Triage routed this item": only a triage run (or the user, Main or
    // a VP, who own the rules) may say so.
    const caller = await callerTask(req)
    const role = caller?.task?.org_role
    if (caller && !caller.task?.triage && role !== 'main' && role !== 'lead') {
      sendError(res, 403, 'routing_rule_router',
        'triage_route is Inbox Triage\'s hand-off of an item a routing rule matched. Send your own message with task_send.')
      return
    }
    const id = String(req.params.id ?? '')
    const rule = (await readRoutingRules(WALNUT_HOME)).find((r) => r.id === id)
    if (!rule) {
      sendError(res, 404, 'not_found', `No routing rule ${id}`)
      return
    }
    if (!rule.enabled) {
      sendError(res, 409, 'rule_disabled', `Routing rule ${id} is turned off: leave the item for the summary.`)
      return
    }
    const target = await taskOf(rule.taskId)
    if (!target || target.phase === 'COMPLETE') {
      sendError(res, 409, 'task_complete', `Routing rule ${id} sends to a task that is ${target ? 'complete' : 'gone'}: leave the item for the summary.`)
      return
    }
    const b = body(req)
    const item = (str(b.item) ?? '').replace(/\s+/g, ' ').trim()
    const text = (str(b.text) ?? '').trim()
    if (!item || !text) {
      sendError(res, 400, 'bad_request', 'route needs `item` (its subject or first words) and `text` (what arrived and what it asks).')
      return
    }
    const source = b.source === 'slack' ? 'slack' : b.source === 'mail' ? 'mail' : undefined
    const { performSessionSend, SendError } = await import('../../core/sessions/session-send-core.js')
    const routedText = `${routedHeader(rule)}\n\nItem: ${item}\n\n${text}`
    try {
      const result = await performSessionSend({
        to: rule.taskId,
        text: routedText,
        expectReply: false,
        callerSid: header(req, 'x-walnut-caller-sid'),
        callerHost: header(req, 'x-walnut-caller-host'),
        // Never the user's own words, even with no caller session: a routed item is Walnut's note.
        source: 'api-agent',
        callerLabel: 'Inbox Triage routing rule',
      })
      // The item is delivered: a failed note must not read as a failed route (a retry would send it twice).
      await noteRoutedItem(WALNUT_HOME, rule.id, { at: Date.now(), item, ...(source ? { source } : {}) })
        .catch((err) => log.web.warn('triage routed item not noted on its rule', { ruleId: rule.id, error: String(err) }))
      log.web.info('triage item routed by rule', { ruleId: rule.id, taskId: rule.taskId, source })
      const noted = (await readRoutingRules(WALNUT_HOME)).find((r) => r.id === rule.id) ?? rule
      res.status(202).json({ rule: await view(noted), delivered: result })
    } catch (err) {
      if (err instanceof SendError && err.code === 'task_has_no_session') {
        // The rule's task has never run (a placeholder the user made for this mail): the item
        // is its first message. Started on the task's own place, never the triage run's.
        await startWithItem(rule, routedText, item, source, res)
        return
      }
      if (err instanceof SendError) {
        sendError(res, err.statusCode, err.code, err.message, err.detail)
        return
      }
      throw err
    }
  } catch (err) { if (!routingError(res, err)) next(err) }
})

async function startWithItem(
  rule: TriageRoutingRule, text: string, item: string, source: 'mail' | 'slack' | undefined, res: Response,
): Promise<void> {
  const { startSessionForTask } = await import('../../core/sessions/task-start.js')
  try {
    // No caller session: a start from the run would take its cwd and host for the user's task.
    const started = await startSessionForTask({ taskIdPrefix: rule.taskId, message: text, source: 'api-agent' })
    await noteRoutedItem(WALNUT_HOME, rule.id, { at: Date.now(), item, ...(source ? { source } : {}) })
      .catch((err) => log.web.warn('triage routed item not noted on its rule', { ruleId: rule.id, error: String(err) }))
    log.web.info('triage item routed by rule (task started)', { ruleId: rule.id, taskId: rule.taskId, source })
    const noted = (await readRoutingRules(WALNUT_HOME)).find((r) => r.id === rule.id) ?? rule
    res.status(202).json({ rule: await view(noted), started })
  } catch (err) {
    const e = err as { statusCode?: number; status?: number; code?: string; message?: string }
    sendError(res, e.statusCode ?? e.status ?? 409, e.code ?? 'start_failed',
      `The rule's task has not started and could not be started: ${e.message ?? String(err)}. Leave the item for the summary.`)
  }
}
