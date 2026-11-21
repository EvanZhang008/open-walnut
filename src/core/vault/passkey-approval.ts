/**
 * Every passkey Walnut makes or signs with needs the person's yes for that one request
 * (docs/reference/passwords.md, "Passkeys in the browser"). An unlocked vault session is not
 * enough: the browser extension, or anything holding its session, could otherwise sign in as the
 * person anywhere. So:
 *
 *   begin    the request (a registration or a sign-in, already checked as the final step checks
 *            it) is kept here, bound to the vault session that asked, with a fresh challenge and a
 *            short clock. Nothing is made or signed.
 *   approve  the same session brings proof: the person's confirm key signed the challenge with
 *            user verification (Touch ID, through the browser's own WebAuthn in an extension page;
 *            passkey-confirm-keys.ts), or the master password was checked again (the route does
 *            that, as an export does). Only then is the KEPT request run, once: the caller cannot
 *            swap in another site, account or credential between the two steps.
 *
 * Pending requests live in memory only: a restart drops them, and the person asks again.
 */
import crypto from 'node:crypto'
import { PasskeyError, b64u } from './passkey.js'
import {
  createPasskey, signInWithPasskey, checkCreate, checkAssert, cleanRequest,
  type CreateRequest, type AssertRequest, type Created, type Asserted, type RequestSummary,
} from './passkey-store.js'
import { verifyConfirmAssertion, type ConfirmAssertion } from './passkey-confirm-keys.js'

export const APPROVAL_MS = 120_000
const MAX_PENDING = 20

type Op = 'create' | 'get'
interface Pending {
  id: string
  op: Op
  session: string
  challenge: string
  expiresAt: number
  request: CreateRequest | AssertRequest
  summary: RequestSummary
}

const pending = new Map<string, Pending>()

const hashOf = (token: string) => crypto.createHash('sha256').update(`walnut-passkey-approval\0${token}`).digest('hex')

function sweep(now: number): void {
  for (const [id, p] of pending) if (p.expiresAt <= now) pending.delete(id)
}

export interface Begun { id: string; challenge: string; expiresAt: string; summary: RequestSummary }

/** Keep a checked request for the person's yes. `session` is the caller's vault session token. */
export async function beginApproval(op: unknown, request: unknown, session: string | undefined, now = Date.now()): Promise<Begun> {
  if (!session) throw new PasskeyError('A vault session is needed', 401, 'vault_session_needed')
  if (op !== 'create' && op !== 'get') throw new PasskeyError('op must be create or get', 400, 'bad_passkey_request')
  const req = cleanRequest(op, request)
  const summary = op === 'create' ? await checkCreate(req as CreateRequest) : await checkAssert(req as AssertRequest)
  sweep(now)
  const mine = [...pending.values()].filter((p) => p.session === hashOf(session))
  // One person answers one request at a time; a page that keeps asking cannot pile up approvals.
  if (mine.length >= MAX_PENDING) pending.delete(mine.sort((a, b) => a.expiresAt - b.expiresAt)[0].id)
  const p: Pending = {
    id: `pka-${crypto.randomBytes(12).toString('hex')}`,
    op,
    session: hashOf(session),
    challenge: b64u(crypto.randomBytes(32)),
    expiresAt: now + APPROVAL_MS,
    request: req as CreateRequest | AssertRequest,
    summary,
  }
  pending.set(p.id, p)
  return { id: p.id, challenge: p.challenge, expiresAt: new Date(p.expiresAt).toISOString(), summary }
}

/** How the person said yes: a confirm key's signature over the challenge, or the master password (checked by the caller). */
export type Proof = { kind: 'key'; assertion: ConfirmAssertion } | { kind: 'password' }

function take(id: unknown, session: string | undefined, now: number): Pending {
  sweep(now)
  const p = typeof id === 'string' ? pending.get(id) : undefined
  if (!p || !session || p.session !== hashOf(session)) throw new PasskeyError('This passkey request has ended: ask again from the site', 410, 'passkey_approval_gone')
  return p
}

/** The pending request still open for this session (the confirm window shows it, the password check runs before approve). */
export function pendingApproval(id: unknown, session: string | undefined, now = Date.now()): { id: string; op: Op; challenge: string; expiresAt: string; summary: RequestSummary } {
  const p = take(id, session, now)
  return { id: p.id, op: p.op, challenge: p.challenge, expiresAt: new Date(p.expiresAt).toISOString(), summary: p.summary }
}

/** Run the kept request once, after the proof checks out. The request is gone afterwards, whatever happens. */
export async function approve(id: unknown, session: string | undefined, proof: Proof, now = Date.now()): Promise<({ op: 'create' } & Created) | ({ op: 'get' } & Asserted)> {
  const p = take(id, session, now)
  if (proof.kind === 'key') await verifyConfirmAssertion(proof.assertion, p.challenge)
  // Consumed before the work, and only by the first: two approvals that both passed the check
  // (the same signature sent twice at once) never run the request twice.
  if (!pending.delete(p.id)) throw new PasskeyError('This passkey request has ended: ask again from the site', 410, 'passkey_approval_gone')
  if (p.op === 'create') return { op: 'create', ...(await createPasskey(p.request as CreateRequest)) }
  return { op: 'get', ...(await signInWithPasskey(p.request as AssertRequest)) }
}

/** The person said no (or the page went away): forget it. */
export function cancelApproval(id: unknown, session: string | undefined): void {
  if (typeof id !== 'string' || !session) return
  const p = pending.get(id)
  if (p && p.session === hashOf(session)) pending.delete(id)
}

export function resetPasskeyApprovalsForTest(): void { pending.clear() }
