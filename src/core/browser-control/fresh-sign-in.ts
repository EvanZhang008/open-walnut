/**
 * A second sign-in on a site the person already has open in a tab of their own (routes/browser-v1.ts
 * refuses fill_login there, `site_open_in_person_tab`). Only the person lets it go ahead: their own
 * request (no session behind it), or their yes on a Walnut approval this module asks for. An
 * agent's own `fresh_sign_in: true` only starts that ask (review 2026-11-07: the flag alone was
 * the agent vouching for the person). The ask is like an outward step's (outward-asks.ts): a
 * notification on their Mac and phone that needs a person's proof, open ASK_MS. A yes is bound to
 * the task, the browser, the tab and the site it was asked for, and lets one fill through within
 * GRANT_MS; a tab gone to another site, another tab or another task finds no grant.
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

export function _resetFreshSignInForTesting(): void { asks.clear(); grants.clear() }

async function signers(): Promise<SignerKind[]> {
  const { activeKeys } = await import('../approvals/keys.js')
  return signerKinds(await activeKeys())
}

function sweep(now = Date.now()): void {
  for (const [id, a] of asks) if (now - a.at > ASK_MS) asks.delete(id)
  for (const [id, g] of grants) if (now - g.at > GRANT_MS) grants.delete(id)
}

/** The person said yes for exactly this task, browser, tab and site, recently. */
export function hasGrant(scope: Scope): boolean {
  sweep()
  for (const g of grants.values()) if (same(g, scope)) return true
  return false
}

/** The fill went through: the yes is used. */
export function useGrant(scope: Scope): void {
  for (const [id, g] of grants) if (same(g, scope)) grants.delete(id)
}

export const isFreshAsk = (id: unknown): boolean => typeof id === 'string' && asks.has(id)

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
  for (const [id, a] of asks) if (same(a, scope)) return waiting(id, input.site)
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
  asks.delete(input.id)
  await store.noteAskerRead(input.id)
  if (rec?.status === 'approved') { grants.set(input.id, { ...a, at: Date.now() }); return { ok: true } }
  if (rec?.status === 'denied') {
    return { ok: false, status: 403, body: { error: `The person said no to a new sign-in on ${a.site}: ask them to hand you their tab ("Act in tab" in Walnut's side panel) instead.`, code: 'denied' } }
  }
  return { ok: false, status: 409, body: { error: `Nobody answered within ${MINUTES} minutes: nothing was filled. Ask the person for their tab instead.`, code: 'outward_expired' } }
}
