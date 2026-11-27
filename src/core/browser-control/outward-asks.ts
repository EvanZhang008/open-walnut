/**
 * An agent's step in the person's browser that buys or pays, sends or posts, or deletes waits for
 * their yes (the page judges the step, the extension's page-agent-outward.ts; routes/browser-v1.ts
 * asks here). Only the agent's own click, Enter or typed text is judged: `evaluate`, the page's own
 * scripts and a link that acts on a plain GET are not. The ask is a Walnut approval like the
 * vault's (a notification on their Mac and phone), open until they answer (at most held-asks.ts
 * HOLD_MS: store.ts `untilBack`), answered with a tap on any device they are signed in on. The act answers 202 `needs_ok` with `request`; the agent calls the same action again
 * with it (and `wait_ms`), and once the person approved, the step goes to the page with the
 * approval's signature of exactly that step (`outward_ok`), which the page checks against the
 * element it would act on. One use.
 */
import { BrowserError } from './hub.js'
import { keptMap } from '../kept-asks.js'
import { WHERE_ASKED, askEndOf, askExpiredWords, askOpenWords, type AskEnd } from '../approvals/types.js'
import type { AgentRequester } from '../vault/agent.js'

/** An ask's short clock: what an ask an older Walnut kept is read with, and what one past store.ts UNTIL_BACK_MAX gets. */
export const ASK_MS = 10 * 60_000

/** What the page held: the step, why it counts, the page, and the step's signature. */
export interface Hold { kind: 'buy' | 'send' | 'delete'; why: string; what: string; url: string; sig: string; message?: string; total?: string }

/** How long a yes waits for its step, from the person's tap: a yes nobody took is not spent days later. */
export const TAKE_MS = 60 * 60_000

/** `end`: the approval's own end (absent in an ask an older Walnut kept: ASK_MS after `at`). */
interface Ask { owner: string; tab: number; action: string; key: string; hold: Hold; at: number; end?: AskEnd }
const endOf = (a: Ask): AskEnd => a.end ?? { until: a.at + ASK_MS }
/** Kept across a restart (core/kept-asks.ts): the agent's call after a deploy finds its ask. */
const asks = keptMap<Ask>('browser-outward-asks')

export function _resetOutwardAsksForTesting(): void { asks.clear() }

/** The parts of an act that make it the same step. */
export function stepKey(action: string, args: Record<string, unknown>): string {
  const pick = ['ref', 'x', 'y', 'key', 'text', 'submit', 'clear', 'trusted', 'to_ref', 'to_x', 'to_y', 'slowly', 'accept', 'label'].map((k) => [k, args[k] ?? null])
  return JSON.stringify([action, pick])
}

export function holdOf(extra: Record<string, unknown>): Hold | null {
  const h = extra.hold as Partial<Hold> | undefined
  if (!h || typeof h.sig !== 'string' || typeof h.what !== 'string' || !['buy', 'send', 'delete'].includes(String(h.kind))) return null
  return {
    kind: h.kind as Hold['kind'], why: String(h.why ?? '').slice(0, 200), what: h.what.slice(0, 200), url: String(h.url ?? '').slice(0, 2000), sig: h.sig.slice(0, 400),
    ...(typeof h.message === 'string' && h.message ? { message: h.message.slice(0, 300) } : {}),
    ...(typeof h.total === 'string' && h.total ? { total: h.total.slice(0, 40) } : {}),
  }
}

const hostOf = (u: string) => { try { return new URL(u).host } catch { return 'the page' } }

function waiting(id: string, hold: Hold, end: AskEnd): Record<string, unknown> {
  return {
    status: 'needs_ok', code: 'outward_needs_ok', request: id, approvalId: id, kind: hold.kind, what: hold.what, url: hold.url,
    waitsMinutes: Math.max(1, Math.round((end.until - Date.now()) / 60_000)), expiresAt: new Date(end.until).toISOString(), ...(end.untilBack ? { untilBack: true } : {}),
    error: `Waiting for the person to approve: ${hold.what} on ${hostOf(hold.url)} (${hold.why}). ${WHERE_ASKED}. ${askOpenWords(end)}`,
  }
}

const ACT: Record<Hold['kind'], string> = { buy: 'buy', send: 'send', delete: 'delete' }
/** Why a step on a button waits, said once (the button is already named in the title). */
const STEP_WHY: Record<Hold['kind'], string> = { buy: 'It buys or pays.', send: 'It sends or posts.', delete: 'It deletes something.' }

/**
 * Why the step waits for the person, as the card's last sentence: the reason the asking agent is
 * told (`hold.why`, from the page), without the button's name again ("Place order" buys or pays
 * becomes "It buys or pays."). Review 2026-11-06 round 3: the card said what and where but not why.
 */
export function whySentence(hold: Pick<Hold, 'kind' | 'why'>): string {
  const why = hold.why.trim()
  if (!why || why.startsWith('"')) return STEP_WHY[hold.kind]
  const line = why.charAt(0).toUpperCase() + why.slice(1)
  return /[.!?]$/.test(line) ? line : `${line}.`
}

/** The card's words: who asks, exactly what, where and why; for a send the message, for an order its total. */
export function askWords(hold: Hold, taskTitle?: string): { what: string; detail: string } {
  const who = taskTitle ? `"${taskTitle.length > 60 ? `${taskTitle.slice(0, 59)}…` : taskTitle}"` : 'a Walnut agent'
  const host = hostOf(hold.url)
  const on = hold.kind === 'send' && hold.message ? `: "${hold.message.length > 80 ? `${hold.message.slice(0, 79)}…` : hold.message}"` : hold.kind === 'buy' && hold.total ? ` (${hold.total})` : ''
  const head = `Let ${who} ${hold.what} on ${host}${on}?`
  const why = ` ${whySentence(hold)}`
  // An approval's title holds 300 characters (APPROVAL_WHAT_MAX): a long message gives way, the
  // reason stays; the detail has the rest.
  const room = 300 - why.length
  const what = `${head.length > room ? `${head.slice(0, room - 2)}…?` : head}${why}`
  const lines = [
    `${taskTitle ? `The task "${taskTitle}"` : 'A Walnut agent (not inside a task)'} wants to ${hold.what} in your browser, which would ${ACT[hold.kind]} something in your name (${hold.why}).`,
    `Page: ${hold.url}`,
    ...(hold.message ? [`Message it sends: ${hold.message}`] : []),
    ...(hold.total ? [`Order total on the page: ${hold.total}`] : []),
    'Approve to let it take this one step; deny and it stops there.',
  ]
  return { what, detail: lines.join('\n') }
}

/** The page held a step: the person is asked. */
export async function askOutward(input: { owner: string; tab: number; action: string; args: Record<string, unknown>; hold: Hold; requester: AgentRequester; testRun?: string }): Promise<Record<string, unknown>> {
  const now = Date.now()
  for (const [id, a] of asks) if (now > endOf(a).until) asks.delete(id)
  const key = stepKey(input.action, input.args)
  // The same step asked again while its ask is open (or answered and not yet taken): the same ask.
  // The same step is what the person read (the hold's signature: the button, the page, the message,
  // the total, and the page's whole address), so a new ref after a reload or the same page in
  // another of the task's tabs finds it too, and the ask now follows this call (2026-11-26: a
  // payment asked twice). A waiter on its old tab then finds it moved (answerOutward).
  for (const [id, a] of asks) {
    if (a.owner !== input.owner || a.hold.sig !== input.hold.sig || a.hold.url !== input.hold.url) continue
    if (a.tab !== input.tab || a.key !== key || a.action !== input.action) asks.set(id, { ...a, tab: input.tab, key, action: input.action })
    return waiting(id, a.hold, endOf(a))
  }
  const store = await import('../approvals/store.js')
  const words = askWords(input.hold, input.requester.taskTitle)
  const made = await store.createApproval({
    what: words.what,
    detail: words.detail, detailRole: 'summary',
    // Open until the person answers, while they are away too; this session is told the answer.
    timeoutMs: ASK_MS, untilBack: true, requester: input.requester, ...(input.testRun ? { testRun: input.testRun } : {}),
  })
  const id = made.approval.id
  const end = askEndOf(made.approval)
  asks.set(id, { owner: input.owner, tab: input.tab, action: input.action, key, hold: input.hold, at: now, end })
  return waiting(id, input.hold, end)
}

/**
 * The agent called again with the ask's `request`: held up to `holdMs` for the answer. Approved,
 * the step's signature to send with it; still open, 202 again; denied or expired, refused.
 */
export async function answerOutward(input: { id: string; owner: string; tab: number; action: string; args: Record<string, unknown>; holdMs: number }): Promise<{ ok: true; sig: string } | { ok: false; status: number; body: Record<string, unknown> }> {
  const a = asks.get(input.id)
  if (!a || a.owner !== input.owner || a.tab !== input.tab || a.key !== stepKey(input.action, input.args)) {
    throw new BrowserError('No such ask for this step in this tab: call the action again without request.', 404, 'no_such_request')
  }
  const store = await import('../approvals/store.js')
  let rec = await store.getApproval(input.id)
  const until = Date.now() + Math.max(0, input.holdMs)
  while (rec?.status === 'pending' && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500))
    rec = await store.getApproval(input.id)
  }
  if (rec?.status === 'pending') return { ok: false, status: 202, body: waiting(input.id, a.hold, endOf(a)) }
  // One reader takes the answer: checked and taken with no await between, so two waiters (or one on
  // a tab the ask moved from) never both get the step's signature.
  if (asks.get(input.id) !== a) throw new BrowserError('That ask was already used, or moved to another call: call the action again without request.', 404, 'no_such_request')
  asks.delete(input.id)
  // This call hands the agent the answer itself: its session needs no note about it (tell-asker.ts).
  await store.noteAskerRead(input.id)
  if (rec?.status === 'approved') {
    const answered = Date.parse(rec.answer?.at ?? '') || 0
    if (Date.now() - answered > TAKE_MS) {
      return { ok: false, status: 409, body: { error: `The person approved this more than ${Math.round(TAKE_MS / 60_000)} minutes ago and the step was not taken then: nothing was done. Call the action again to ask anew.`, code: 'outward_expired' } }
    }
    return { ok: true, sig: a.hold.sig }
  }
  if (rec?.status === 'denied') {
    return { ok: false, status: 403, body: { error: `The person said no to: ${a.hold.what}. Nothing was done; do not try it again unless they ask.`, code: 'denied' } }
  }
  const end = endOf(a)
  return { ok: false, status: 409, body: { error: `${askExpiredWords(end)}${end.untilBack ? '' : ' Call the action again to ask anew.'}`, code: 'outward_expired' } }
}
