/**
 * Invites for the Settings page (docs/reference/host-network.md, "Joining a machine"):
 * made on the companion, or with none on this Mac (net-local.ts), and watched until the
 * machine joined; then the Mac syncs (net-mac.ts) and lists it.
 */
import { log } from '../../logging/index.js'
import { NetError } from './net-error.js'
import { setJoined } from './net-rows.js'
import { forgetLocalInvite, localInviteState, makeLocalInvite, resetLocalInvitesForTest } from './net-local.js'
import { validMemberName } from './net-store.js'
import { noteWhere } from './net-where.js'
import { companionCall, errorOf, localDaemon, syncNet } from './net-mac.js'
import { windowsAppPublished } from './join-ps1-published.js'
import { WINDOWS_APP_URL } from './join-ticket.js'

const POLL_MS = 3_000

export interface InviteState {
  id: string
  link: string
  command: string
  /** PowerShell on Windows; absent from a companion older than the Windows join. */
  windowsCommand?: string
  /** Walnut for Windows to download, once the newest release carries it (with a Windows line only). */
  windowsApp?: string
  expiresAt: number
  state: 'waiting' | 'joined' | 'expired' | 'failed'
  member?: { id: string; name: string; platform?: string }
  error?: string
}

type Invite = InviteState & { timer?: ReturnType<typeof setInterval>; local?: boolean }
const invites = new Map<string, Invite>()

function view(i: Invite): InviteState {
  const { timer: _t, local: _l, ...rest } = i
  return rest
}

async function pollInvite(id: string): Promise<void> {
  const inv = invites.get(id)
  if (!inv || inv.state !== 'waiting') return
  // A local invite reads its own end (walnut-net keeps a late join a minute past it).
  if (inv.local) { await pollLocalInvite(inv); return }
  if (Date.now() > inv.expiresAt + POLL_MS) { settle(inv, { state: 'expired' }); return }
  try {
    const { status, body } = await companionCall(`/net/invites/${encodeURIComponent(id)}`, { method: 'GET' })
    if (status === 404) { settle(inv, { state: 'expired' }); return }
    if (status !== 200) return
    if (body.state === 'joined') {
      settle(inv, { state: 'joined', ...(body.member ? { member: body.member as InviteState['member'] } : {}) })
      log.session.info('net: a machine joined', { invite: id, name: inv.member?.name })
      await syncNet()
    } else if (body.state === 'expired') settle(inv, { state: 'expired' })
  } catch (err) {
    log.session.debug('net: invite check failed', { id, error: (err as Error).message })
  }
}

/** No companion: this Mac's walnut-net took the machine in; it goes on this Mac's list. */
async function pollLocalInvite(inv: Invite): Promise<void> {
  try {
    const local = await localDaemon()
    const r = await localInviteState(local, inv.id)
    if (r.state === 'expired') { settle(inv, { state: 'expired' }); return }
    if (r.state !== 'joined' || !r.join) return
    const { memberId, name, platform, at, addrs } = r.join
    // Kept first; walnut-net forgets the invite only after (a failed write keeps it there).
    await setJoined(memberId, { name, ...(platform ? { platform } : {}), addedAt: at })
    await noteWhere(memberId, { addrs: Array.isArray(addrs) ? addrs : [] })
    await forgetLocalInvite(local, inv.id)
    settle(inv, { state: 'joined', member: { id: memberId, name, ...(platform ? { platform } : {}) } })
    log.session.info('net: a machine joined this Mac', { invite: inv.id, name })
    await syncNet()
  } catch (err) {
    log.session.debug('net: invite check failed', { id: inv.id, error: (err as Error).message })
  }
}

function settle(inv: Invite, next: Partial<InviteState>): void {
  Object.assign(inv, next)
  if (inv.timer) clearInterval(inv.timer)
  inv.timer = undefined
}

/** A new invite (turns the network on first). */
export async function makeInvite(input: { name?: unknown }): Promise<InviteState> {
  for (const [id, i] of invites) if (i.state !== 'waiting' && Date.now() - i.expiresAt > 60 * 60_000) invites.delete(id)
  const s = await syncNet({ enable: true })
  if (s.error) throw new NetError(502, 'net_unavailable', s.error)
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : undefined
  let inv: Invite
  if (!s.companion) {
    // No companion: this Mac checks the join itself, so it must be on while the machine joins.
    if (name && !validMemberName(name)) throw new NetError(400, 'bad_name', 'Name the machine with letters, digits, dot, dash or underscore.')
    const made = await makeLocalInvite(await localDaemon(), { macId: s.macId!, relayMode: s.relay === 'none' ? 'none' : 'public', ...(name ? { name } : {}) })
    inv = { ...made, state: 'waiting', local: true }
  } else {
    const { status, body } = await companionCall('/net/invites', { method: 'POST', body: name ? { name } : {} })
    if (status !== 201) { const e = errorOf(body); throw new NetError(status, e.code, e.message) }
    inv = {
      id: String(body.id), link: String(body.link), command: String(body.command),
      ...(typeof body.windowsCommand === 'string' ? { windowsCommand: body.windowsCommand } : {}),
      expiresAt: Number(body.expiresAt), state: 'waiting',
    }
  }
  // A PC joins with the Windows app (it takes the link) once a release carries the app.
  if (inv.windowsCommand && await windowsAppPublished()) inv.windowsApp = WINDOWS_APP_URL
  inv.timer = setInterval(() => { void pollInvite(inv.id) }, POLL_MS)
  inv.timer.unref?.()
  invites.set(inv.id, inv)
  return view(inv)
}

export function inviteStatus(id: string): InviteState | null {
  const i = invites.get(id)
  return i ? view(i) : null
}

/** Tests. */
export function resetInvitesForTest(): void {
  for (const i of invites.values()) if (i.timer) clearInterval(i.timer)
  invites.clear()
  resetLocalInvitesForTest()
}
