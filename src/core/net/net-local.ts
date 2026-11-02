/**
 * Invites with no cloud companion (docs/reference/host-network.md, "Without a companion").
 * The hash of each code waits in this Mac's walnut-net (capability net-join-v1), which
 * takes a machine in on `walnut/join/1` while the invite is open; this Mac reads the
 * result from walnut-net's status. The link is a ticket (core/net/join-ticket.ts): this
 * Mac's id, the code, and how to reach this Mac.
 */
import crypto from 'node:crypto'
import { NetError } from './net-error.js'
import { newInviteCode } from './net-store.js'
import { encodeTicket, ticketCommand } from './join-ticket.js'

const TTL_MS = 10 * 60_000
const HOME_RELAY_WAIT_MS = 8_000
/** Invites walnut-net takes at once (net-core.ts `invites`). */
const MAX_OPEN = 16

interface Pending { id: string; hash: string; name: string | null; expiresAt: number }
const pending = new Map<string, Pending>()

export interface Daemon {
  send(cmd: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  hasCapability(cap: string): boolean
}

/** What walnut-net recorded when a machine came with a code. */
export interface LocalJoin { memberId: string; name: string; hostname: string; platform: string; at: number; addrs?: string[] }

interface NodeStatus { addrs?: string[]; homeRelay?: string | null; invites?: Array<{ id: string; used: LocalJoin | null }> }

/** walnut-net's status, or null while it does not answer (starting, busy): then nothing is decided. */
async function nodeStatus(local: Daemon): Promise<NodeStatus | null> {
  const s = await local.send('net.status', {}, 10_000) as { node?: NodeStatus | null }
  return s.node ?? null
}

// An invite stays listed a minute past its end: one used at the last moment keeps its
// record in walnut-net until this Mac has read it (a list without it drops the record).
const KEEP_AFTER_MS = 60_000

let pushing: Promise<unknown> = Promise.resolve()

/**
 * Hand walnut-net the invites still open or not yet read (it forgets them when it restarts).
 * One at a time, each list read when its turn comes: a list read earlier never lands after
 * a newer one and drops an invite just made.
 */
function pushInvites(local: Daemon): Promise<void> {
  const run = pushing.then(async () => {
    const now = Date.now()
    for (const [id, p] of pending) if (now > p.expiresAt + KEEP_AFTER_MS) pending.delete(id)
    const invites = [...pending.values()].map((p) => ({ id: p.id, codeHash: p.hash, expiresAt: p.expiresAt, name: p.name }))
    const r = await local.send('net.invites', { invites }, 15_000) as { ok?: boolean; error?: string }
    if (!r.ok) throw new NetError(500, 'net_invite_failed', `This Mac's walnut-net did not take the invite: ${r.error ?? 'refused'}`)
  })
  pushing = run.catch(() => {})
  return run
}

export async function makeLocalInvite(local: Daemon, input: { macId: string; relayMode: 'public' | 'none'; name?: string }): Promise<{ id: string; link: string; command: string; expiresAt: number }> {
  if (!local.hasCapability('net-join-v1')) throw new NetError(409, 'daemon_too_old', "This Mac's Walnut daemon cannot take machines in without a companion yet; restart Walnut to update it.")
  // walnut-net holds at most MAX_OPEN; one more would show a link that can never work.
  if ([...pending.values()].filter((p) => Date.now() <= p.expiresAt + KEEP_AFTER_MS).length >= MAX_OPEN) {
    throw new NetError(429, 'too_many_invites', 'Too many links are open; wait until one is used or ends (10 minutes).')
  }
  const { code, hash } = newInviteCode()
  const id = `ni-${crypto.randomBytes(9).toString('base64url')}`
  const expiresAt = Date.now() + TTL_MS
  pending.set(id, { id, hash, name: input.name ?? null, expiresAt })
  try {
    await pushInvites(local)
  } catch (err) {
    pending.delete(id)
    throw err
  }
  let node = (await nodeStatus(local).catch(() => null)) ?? {}
  // A walnut-net that just started on public relays picks its home relay within a second or
  // two: wait for it (bounded), so the ticket says where to reach this Mac behind a router.
  for (let i = 0; input.relayMode === 'public' && !node.homeRelay && i < HOME_RELAY_WAIT_MS / 250; i++) {
    await new Promise((r) => setTimeout(r, 250))
    node = (await nodeStatus(local).catch(() => null)) ?? node
  }
  const ticket = encodeTicket({
    mac: input.macId, code, relayMode: input.relayMode, addrs: node.addrs ?? [],
    relay: input.relayMode === 'public' ? node.homeRelay ?? null : null,
  })
  return { id, link: ticket, command: ticketCommand(ticket), expiresAt }
}

/**
 * Where a local invite stands: the join once the machine came, else waiting or expired.
 * A join is only read here; forgetLocalInvite drops it once this Mac has kept the machine.
 */
export async function localInviteState(local: Daemon, id: string, now = Date.now()): Promise<{ state: 'waiting' | 'joined' | 'expired'; join?: LocalJoin }> {
  const node = await nodeStatus(local)
  if (!node) {
    // No answer: nothing is decided, but an invite long past its end stops being watched.
    const p = pending.get(id)
    return { state: !p || now > p.expiresAt + KEEP_AFTER_MS ? 'expired' : 'waiting' }
  }
  const inv = node.invites?.find((i) => i.id === id)
  if (inv?.used) return { state: 'joined', join: inv.used }
  const p = pending.get(id)
  // Gone from walnut-net (it restarted): never handed over again, since it may have been
  // used just before, and a code works once.
  if (!p || !inv || now > p.expiresAt + KEEP_AFTER_MS) {
    pending.delete(id)
    await pushInvites(local).catch(() => {})
    return { state: 'expired' }
  }
  return { state: 'waiting' }
}

/** The machine is kept: walnut-net may forget the invite. */
export async function forgetLocalInvite(local: Daemon, id: string): Promise<void> {
  pending.delete(id)
  await pushInvites(local).catch(() => {})
}

/**
 * Joins an earlier run of this server never read (it stopped while an invite was open), or
 * null while walnut-net does not answer. Keep them, then clearLeftovers: walnut-net forgets
 * every invite this run did not make, so a code shown before a restart takes no machine in
 * that nobody would list.
 */
export async function leftoverJoins(local: Daemon): Promise<LocalJoin[] | null> {
  if (!local.hasCapability('net-join-v1')) return []
  const node = await nodeStatus(local)
  if (!node) return null
  const mine = new Set(pending.keys())
  return (node.invites ?? []).filter((i) => !mine.has(i.id) && i.used).map((i) => i.used!)
}

export async function clearLeftovers(local: Daemon): Promise<void> {
  if (local.hasCapability('net-join-v1')) await pushInvites(local)
}

/** Tests. */
export function resetLocalInvitesForTest(): void {
  pending.clear()
}
