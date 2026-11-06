/**
 * An agent's step in the person's browser that buys or pays, sends or posts, or deletes waits for
 * their yes (the page judges the step, the extension's page-agent-outward.ts; routes/browser-v1.ts
 * asks here). Only the agent's own click, Enter or typed text is judged: `evaluate`, the page's own
 * scripts and a link that acts on a plain GET are not. The ask is a Walnut approval like the
 * vault's (a notification on their Mac and phone), open for ASK_MS, and like the vault's it needs
 * a person's proof to approve (guard `person`: a device signature, or a Passwords unlock in the
 * window). The act answers 202 `needs_ok` with `request`; the agent calls the same action again
 * with it (and `wait_ms`), and once the person approved, the step goes to the page with the
 * approval's signature of exactly that step (`outward_ok`), which the page checks against the
 * element it would act on. One use.
 */
import { BrowserError } from './hub.js'
import { signerKinds, whereAsked, type SignerKind } from '../approvals/signer-words.js'
import type { AgentRequester } from '../vault/agent.js'

export const ASK_MS = 10 * 60_000

/** What the page held: the step, why it counts, the page, and the step's signature. */
export interface Hold { kind: 'buy' | 'send' | 'delete'; why: string; what: string; url: string; sig: string; message?: string; total?: string }

interface Ask { owner: string; tab: number; action: string; key: string; hold: Hold; at: number }
const asks = new Map<string, Ask>()

export function _resetOutwardAsksForTesting(): void { asks.clear() }

/** The parts of an act that make it the same step. */
export function stepKey(action: string, args: Record<string, unknown>): string {
  const pick = ['ref', 'x', 'y', 'key', 'text', 'submit', 'clear', 'trusted'].map((k) => [k, args[k] ?? null])
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
const MINUTES = Math.round(ASK_MS / 60_000)

async function signers(): Promise<SignerKind[]> {
  const { activeKeys } = await import('../approvals/keys.js')
  return signerKinds(await activeKeys())
}

async function waiting(id: string, hold: Hold): Promise<Record<string, unknown>> {
  return {
    status: 'needs_ok', code: 'outward_needs_ok', request: id, approvalId: id, kind: hold.kind, what: hold.what, url: hold.url, waitsMinutes: MINUTES,
    error: `Waiting for the person to approve: ${hold.what} on ${hostOf(hold.url)} (${hold.why}). ${whereAsked(await signers())}; the ask stays open ${MINUTES} minutes.`,
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
  for (const [id, a] of asks) if (now - a.at > ASK_MS) asks.delete(id)
  const key = stepKey(input.action, input.args)
  // The same step asked again while its ask is open: the same ask.
  for (const [id, a] of asks) if (a.owner === input.owner && a.tab === input.tab && a.key === key && a.hold.sig === input.hold.sig) return waiting(id, a.hold)
  const store = await import('../approvals/store.js')
  const words = askWords(input.hold, input.requester.taskTitle)
  const made = await store.createApproval({
    what: words.what,
    detail: words.detail,
    // A plain tap from this machine is not proof (any process here can send one, the asking agent
    // too): Face ID or Touch ID where a device signs, else this window's Passwords unlock (`person`).
    mode: (await signers()).length ? 'biometric' : 'tap', guard: 'person',
    timeoutMs: ASK_MS, requester: input.requester, ...(input.testRun ? { testRun: input.testRun } : {}),
  })
  const id = made.approval.id
  asks.set(id, { owner: input.owner, tab: input.tab, action: input.action, key, hold: input.hold, at: now })
  return waiting(id, input.hold)
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
  if (rec?.status === 'pending') return { ok: false, status: 202, body: await waiting(input.id, a.hold) }
  asks.delete(input.id)
  // This call hands the agent the answer itself: its session needs no note about it (tell-asker.ts).
  await store.noteAskerRead(input.id)
  if (rec?.status === 'approved') return { ok: true, sig: a.hold.sig }
  if (rec?.status === 'denied') {
    return { ok: false, status: 403, body: { error: `The person said no to: ${a.hold.what}. Nothing was done; do not try it again unless they ask.`, code: 'denied' } }
  }
  return { ok: false, status: 409, body: { error: `Nobody answered within ${MINUTES} minutes: nothing was done. Call the action again to ask anew.`, code: 'outward_expired' } }
}
