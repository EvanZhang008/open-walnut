/**
 * A second sign-in on a site the person already has open in a tab of their own (routes/browser-v1.ts
 * refuses fill_login there, `site_open_in_person_tab`). Only the person lets it go ahead: their own
 * request (no session behind it), or their yes on a Walnut approval this module asks for. An
 * agent's own `fresh_sign_in: true` only starts that ask (review 2026-11-07: the flag alone was
 * the agent vouching for the person). The ask is like an outward step's (outward-asks.ts): a
 * notification on their Mac and phone that needs a person's proof, open ASK_MS. A yes is bound to
 * the task, the browser, the tab and the site it was asked for, and lets one fill through within
 * GRANT_MS of the person's answer (an ask read late gets no fresh window: review 2026-11-07); a
 * tab gone to another site, another tab or another task finds no grant. A fill claims the yes
 * before it starts (claimGrant, one synchronous step), so two fills at once cannot both use it,
 * and gives it back only when nothing was filled (restoreGrant).
 */
import { BrowserError } from './hub.js'
import { ASK_MS } from './outward-asks.js'
import { signerKinds, whereAsked, type SignerKind } from '../approvals/signer-words.js'
import type { AgentRequester } from '../vault/agent.js'

/** How long a yes waits for its fill (the vault may still ask about the login itself meanwhile). */
export const GRANT_MS = 10 * 60_000
const MINUTES = Math.round(ASK_MS / 60_000)

interface Scope { owner: string; device: string; tab: number; site: string }
const asks = new Map<string, Scope & { at: number }>()
const grants = new Map<string, Scope & { at: number }>()
const same = (a: Scope, b: Scope) => a.owner === b.owner && a.device === b.device && a.tab === b.tab && a.site === b.site

export function _resetFreshSignInForTesting(): void { asks.clear(); grants.clear(); codeSteps.clear() }

async function signers(): Promise<SignerKind[]> {
  const { activeKeys } = await import('../approvals/keys.js')
  return signerKinds(await activeKeys())
}

function sweep(now = Date.now()): void {
  // An ask is answered within ASK_MS; its yes may be taken up to GRANT_MS after that answer.
  for (const [id, a] of asks) if (now - a.at > ASK_MS + GRANT_MS) asks.delete(id)
  for (const [id, g] of grants) if (now - g.at > GRANT_MS) grants.delete(id)
}

/** The person said yes for exactly this task, browser, tab and site, recently. */
export function hasGrant(scope: Scope): boolean {
  sweep()
  for (const g of grants.values()) if (same(g, scope)) return true
  return false
}

export interface Claim { id: string; grant: Scope & { at: number } }

/**
 * Take the yes for this task, browser, tab and site, if there is one, in one synchronous step: the
 * fill that holds the claim is the only one that may use it (review 2026-11-07: two fills sent at
 * once both passed a check and both filled).
 */
export function claimGrant(scope: Scope): Claim | undefined {
  sweep()
  for (const [id, g] of grants) {
    if (!same(g, scope)) continue
    grants.delete(id)
    return { id, grant: g }
  }
  return undefined
}

/** Nothing was filled with the claim: the yes stands again, for what is left of its time. */
export function restoreGrant(c: Claim): void {
  if (Date.now() - c.grant.at <= GRANT_MS) grants.set(c.id, c.grant)
}

/**
 * The yes covers the whole sign-in it was given for, its one-time code too: once fill_login used
 * it, one fill_code in the same task, browser, tab and site may follow within the yes's time
 * (codeStepAfter), without asking the person a second time.
 */
const codeSteps = new Map<string, Scope & { at: number; item?: string }>()

/** fill_login filled the login `item` with this claim: that login's code step may follow. */
export function codeStepAfter(c: Claim, item?: string): void {
  if (Date.now() - c.grant.at <= GRANT_MS) codeSteps.set(c.id, { ...c.grant, ...(item ? { item } : {}) })
}

/** The login a code step is for (the one its sign-in filled). */
export const codeStepItem = (c: Claim): string | undefined => (c.grant as { item?: string }).item

/** Take the code step a fresh sign-in left for exactly this scope, in one synchronous step. */
export function claimCodeStep(scope: Scope): Claim | undefined {
  const now = Date.now()
  for (const [id, g] of codeSteps) {
    if (now - g.at > GRANT_MS) { codeSteps.delete(id); continue }
    if (!same(g, scope)) continue
    codeSteps.delete(id)
    return { id, grant: g }
  }
  return undefined
}

/** Nothing was filled with the code step: it stands again. */
export function restoreCodeStep(c: Claim): void { codeStepAfter(c, codeStepItem(c)) }

export const isFreshAsk = (id: unknown): boolean => { sweep(); return typeof id === 'string' && asks.has(id) }

async function waiting(id: string, site: string): Promise<Record<string, unknown>> {
  return {
    status: 'needs_ok', code: 'fresh_sign_in_needs_ok', request: id, approvalId: id, site, waitsMinutes: MINUTES,
    error: `Waiting for the person to approve a new sign-in on ${site}, which they already have open in a tab of their own. ${whereAsked(await signers())}; the ask stays open ${MINUTES} minutes.`,
  }
}

/** Ask the person whether this task may sign in again on the site. */
export async function askFreshSignIn(input: Scope & { theirs: Array<{ id: number; title?: string }>; requester: AgentRequester; testRun?: string }): Promise<Record<string, unknown>> {
  sweep()
  const scope: Scope = { owner: input.owner, device: input.device, tab: input.tab, site: input.site }
  for (const [id, a] of asks) if (same(a, scope) && Date.now() - a.at < ASK_MS) return waiting(id, input.site)
  const store = await import('../approvals/store.js')
  const who = input.requester.taskTitle ? `"${input.requester.taskTitle.slice(0, 60)}"` : 'a Walnut agent'
  const tabs = input.theirs.slice(0, 3).map((t) => `tab ${t.id}${t.title ? ` ("${t.title.slice(0, 60)}")` : ''}`).join(', ')
  const made = await store.createApproval({
    what: `Let ${who} sign in again on ${input.site}? You already have it open (${tabs}).`.slice(0, 300),
    detail: [
      `${input.requester.taskTitle ? `The task "${input.requester.taskTitle}"` : 'A Walnut agent'} wants to sign in to ${input.site} with your saved login in its own tab ${input.tab}, although you have the site open yourself (${tabs}).`,
      'Approve only if you asked it for a new sign-in there. Deny, and it asks you for your tab instead.',
    ].join('\n'),
    mode: (await signers()).length ? 'biometric' : 'tap', guard: 'person',
    timeoutMs: ASK_MS, requester: input.requester, ...(input.testRun ? { testRun: input.testRun } : {}),
  })
  asks.set(made.approval.id, { ...scope, at: Date.now() })
  return waiting(made.approval.id, input.site)
}

/** The agent called again with the ask's request: held up to holdMs; a yes becomes the grant. */
export async function answerFreshSignIn(input: Scope & { id: string; holdMs: number }): Promise<{ ok: true } | { ok: false; status: number; body: Record<string, unknown> }> {
  sweep()
  const a = asks.get(input.id)
  if (!a || !same(a, input)) throw new BrowserError('No such ask for a new sign-in in this tab on this site: call fill_login again without request.', 404, 'no_such_request')
  const store = await import('../approvals/store.js')
  let rec = await store.getApproval(input.id)
  const until = Date.now() + Math.max(0, input.holdMs)
  while (rec?.status === 'pending' && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500))
    rec = await store.getApproval(input.id)
  }
  if (rec?.status === 'pending') return { ok: false, status: 202, body: await waiting(input.id, a.site) }
  // One reader turns the answer into its yes: a second call with the same ask that was waiting
  // too finds it taken (checked and taken with no await between, so two cannot both get a yes).
  if (asks.get(input.id) !== a) throw new BrowserError('That ask was already used: call fill_login again without request.', 404, 'no_such_request')
  asks.delete(input.id)
  let out: { ok: true } | { ok: false; status: number; body: Record<string, unknown> }
  if (rec?.status === 'approved') {
    // The yes counts from when the person gave it, not from when the agent came back for it.
    const answered = Date.parse(rec.answer?.at ?? '') || 0
    if (Date.now() - answered > GRANT_MS) {
      out = { ok: false, status: 409, body: { error: `The person approved this sign-in more than ${Math.round(GRANT_MS / 60_000)} minutes ago: nothing was filled. Call fill_login again with fresh_sign_in: true to ask anew.`, code: 'fresh_sign_in_expired' } }
    } else {
      grants.set(input.id, { ...a, at: answered })
      out = { ok: true }
    }
    await store.noteAskerRead(input.id)
    return out
  }
  await store.noteAskerRead(input.id)
  if (rec?.status === 'denied') {
    return { ok: false, status: 403, body: { error: `The person said no to a new sign-in on ${a.site}: ask them to hand you their tab ("Act in tab" in Walnut's side panel) instead.`, code: 'denied' } }
  }
  return { ok: false, status: 409, body: { error: `Nobody answered within ${MINUTES} minutes: nothing was filled. Ask the person for their tab instead.`, code: 'outward_expired' } }
}
