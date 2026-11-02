/**
 * The host network on the cloud companion (core/net/net-store.ts,
 * docs/reference/host-network.md):
 *
 *   GET    /api/v1/net/info                the owner Mac -> {relays, relayRoots, members}
 *   PUT    /api/v1/net/self {endpointId, name}           the owner Mac says its own id
 *   POST   /api/v1/net/invites {name?}     the owner Mac -> {id, code, link, command, expiresAt}
 *   GET    /api/v1/net/invites/:id         the owner Mac -> {state, member?}
 *   DELETE /api/v1/net/members/:id         the owner Mac removes a machine
 *   POST   /api/v1/net/join {code, endpointId, hostname, platform}
 *                                          the new machine, no token -> {name, relays, relayRoots, members}
 *   POST   /api/v1/net/relay-access        the relay on this box: is X-Iroh-Endpoint-Id a member? "true"
 *   GET    /join/:code                     the install script the invite link runs (net-join-script.ts)
 *   GET    /join/:code/windows             the same for a Windows PC, in PowerShell (net-join-ps1.ts)
 *
 * The owner is the Mac this companion belongs to (the machine credential rules,
 * machine-credentials.ts). The join and the script are public: the invite code is
 * their credential, one use, 10 minutes, and a wrong one counts toward the caller's
 * auth rate limit. The relay's check answers only this box's relay: a request Caddy
 * carried in from outside (it adds X-Forwarded-For) is refused, and the relay sends
 * the token setup.sh wrote for it. Companion only: a primary answers 404.
 */
import fs from 'node:fs'
import crypto from 'node:crypto'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { isCompanion } from '../../core/server-role.js'
import { log } from '../../logging/index.js'
import {
  NetStoreError, inviteStatus, isMember, listMembers, makeInvite, peekInvite, redeemInvite, removeMember, restoreHostMember, setMacMember, validNetId,
} from '../../core/net/net-store.js'
import { joinScript } from '../../core/net/net-join-script.js'
import { joinScriptWindows } from '../../core/net/net-join-ps1.js'
import { linkWindowsCommand } from '../../core/net/join-ticket.js'
import { requestOrigin } from '../middleware/request-origin.js'
import { isLocalOrigin } from '../../lib/caller-origin.js'

export const netV1Router = Router()
export const netJoinPageRouter = Router()

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } })
}

/** This companion's public origin, as the invite link and the script name it. */
function originOf(req: Request): string {
  const env = process.env.WALNUT_PUBLIC_ORIGIN
  if (env) return env.replace(/\/+$/, '')
  const proto = (req.get('x-forwarded-proto') ?? req.protocol).split(',')[0].trim() === 'https' ? 'https' : 'http'
  return `${proto}://${req.get('host') ?? ''}`
}

/** The relay(s) and the trust root of their address-discovery listener (setup.sh writes both). */
export function relayInfo(origin: string, env: NodeJS.ProcessEnv = process.env): { relays: string[]; relayRoots: string[] } {
  const relays = (env.WALNUT_NET_RELAYS ?? origin).split(',').map((s) => s.trim()).filter(Boolean)
  const roots: string[] = []
  const rootFile = env.WALNUT_NET_RELAY_ROOT_FILE
  if (rootFile) {
    try {
      const pem = fs.readFileSync(rootFile, 'utf8')
      if (pem.includes('-----BEGIN CERTIFICATE-----')) roots.push(pem)
    } catch { /* no address discovery: links stay on the relay until it is there */ }
  }
  return { relays, relayRoots: roots }
}

const OWNER_ONLY = 'Only the Mac this cloud companion belongs to can manage its machines.'

/**
 * Only the Mac this companion belongs to: the recorded owner; on a companion from before
 * owners were recorded, the device that holds its machine credentials, or the one that
 * proves the bridge-local. Never "the first paired device to ask" (the rule a mint has
 * there): a key it put in the Mac's place would be let in by every machine that joins.
 */
async function owner(req: Request): Promise<{ ok: true } | { ok: false; status: number; code: string; error: string }> {
  const header = req.headers.authorization
  const r = req as Request & { deviceName?: string }
  const refused = { ok: false as const, status: 403, code: 'owner_only', error: OWNER_ONLY }
  if (!r.deviceName || !header?.startsWith('Bearer ')) return refused
  const [{ readRegistry, isPhoneRecord }, actor, { MACHINE_PROOF_HEADER }] = await Promise.all([
    import('../../core/device-store.js'), import('../../core/device-actor.js'), import('../../core/machine-credentials.js'),
  ])
  const reg = await readRegistry()
  const me = actor.recordForToken(reg.devices, header.slice(7))
  if (!me || me.kind === 'machine' || !me.id || isPhoneRecord(me)) return refused
  const recorded = actor.ownerRecord(reg)
  if (recorded) return recorded === me ? { ok: true } : refused
  if (reg.devices.some((d) => d.kind === 'machine' && actor.liveOwnerOf(d, reg.devices) === me)) return { ok: true }
  const proof = req.get(MACHINE_PROOF_HEADER)
  const bridgeLocal = reg.devices.some((d) => d.kind === 'machine' && d.name === actor.PRIMARY_MACHINE_CREDENTIAL && !actor.liveOwnerOf(d, reg.devices))
  return bridgeLocal && proof && proof.length <= 128 && actor.proofClaim(reg, me, proof) ? { ok: true } : refused
}

function guard(fn: (req: Request, res: Response) => Promise<void>, opts: { ownerOnly: boolean }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isCompanion()) return fail(res, 404, 'not_companion', 'The host network is kept by the cloud companion')
      if (opts.ownerOnly) {
        const o = await owner(req)
        if (!o.ok) return fail(res, o.status, o.code, o.error)
      }
      await fn(req, res)
    } catch (err) {
      if (err instanceof NetStoreError) return fail(res, err.status, err.code, err.message)
      next(err)
    }
  }
}

function membersView() {
  return listMembers().map((m) => ({ id: m.id, name: m.name, role: m.role, ...(m.platform ? { platform: m.platform } : {}), addedAt: m.addedAt }))
}

netV1Router.get('/net/info', guard(async (req, res) => {
  res.json({ ...relayInfo(originOf(req)), members: membersView() })
}, { ownerOnly: true }))

netV1Router.put('/net/self', guard(async (req, res) => {
  const body = (req.body ?? {}) as { endpointId?: unknown; name?: unknown }
  const mac = setMacMember({ id: body.endpointId, name: body.name })
  log.web.info('net: the Mac set its id', { id: mac.id })
  res.json({ member: mac })
}, { ownerOnly: true }))

netV1Router.post('/net/invites', guard(async (req, res) => {
  const body = (req.body ?? {}) as { name?: unknown }
  const made = makeInvite({ name: body.name })
  const origin = originOf(req)
  const link = `${origin}/join/${made.code}`
  log.web.info('net: invite made', { id: made.id })
  res.status(201).json({ ...made, link, command: `curl -fsSL ${link} | sh`, windowsCommand: linkWindowsCommand(link) })
}, { ownerOnly: true }))

netV1Router.get('/net/invites/:id', guard(async (req, res) => {
  res.json(inviteStatus(String(req.params.id ?? '')))
}, { ownerOnly: true }))

netV1Router.put('/net/members/:id', guard(async (req, res) => {
  const body = (req.body ?? {}) as { name?: unknown; platform?: unknown }
  const { member, restored } = restoreHostMember({ id: String(req.params.id ?? ''), name: body.name, platform: body.platform })
  if (restored) log.web.info('net: the Mac put back a machine the list had lost', { id: member.id, name: member.name })
  res.json({ member, restored })
}, { ownerOnly: true }))

netV1Router.delete('/net/members/:id', guard(async (req, res) => {
  const id = String(req.params.id ?? '')
  if (!validNetId(id)) return fail(res, 400, 'bad_id', 'Not a member id')
  if (!removeMember(id)) return fail(res, 404, 'not_member', 'No such machine (the Mac stays a member)')
  log.web.info('net: member removed', { id })
  res.json({ removed: id })
}, { ownerOnly: true }))

async function rateLimited(req: Request): Promise<{ limited: boolean; key: string; record: () => void }> {
  const [{ isAuthRateLimited, recordAuthFailure }, { rateLimitClientIp }] = await Promise.all([
    import('../middleware/auth-rate-limit.js'), import('../middleware/local-trust.js'),
  ])
  const key = `net-invite:${rateLimitClientIp(req)}`
  return { limited: isAuthRateLimited(key), key, record: () => recordAuthFailure(key) }
}

netV1Router.post('/net/join', guard(async (req, res) => {
  const rl = await rateLimited(req)
  if (rl.limited) return fail(res, 429, 'rate_limited', 'Too many wrong codes. Wait a minute, then try again.')
  const body = (req.body ?? {}) as { code?: unknown; endpointId?: unknown; hostname?: unknown; platform?: unknown }
  if (!peekInvite(body.code)) {
    rl.record()
    return fail(res, 400, 'invalid_code', 'This invite is not valid any more (used, or older than 10 minutes). Make a new one on your Mac.')
  }
  const member = redeemInvite({ code: body.code, endpointId: body.endpointId, hostname: body.hostname, platform: body.platform })
  log.web.info('net: machine joined', { id: member.id, name: member.name, platform: member.platform })
  // The machine lets in the Mac(s) only; it dials nobody itself.
  const macs = listMembers().filter((m) => m.role === 'mac').map((m) => ({ id: m.id, name: m.name, accept: true }))
  res.json({ name: member.name, ...relayInfo(originOf(req)), members: macs })
}, { ownerOnly: false }))

/** The relay's own token (setup.sh), compared in constant time. */
// The relay asks about every connection, and a refused one about once a second: the token
// file is read again at most every 30 s, never per request.
let relayToken: { file: string; value: string; at: number } | null = null

function relayTokenOk(req: Request): boolean {
  const file = process.env.WALNUT_NET_RELAY_TOKEN_FILE
  if (!file) return false
  if (!relayToken || relayToken.file !== file || Date.now() - relayToken.at > 30_000) {
    let value = ''
    try { value = fs.readFileSync(file, 'utf8').trim() } catch { /* none: refuse */ }
    relayToken = { file, value, at: Date.now() }
  }
  const want = Buffer.from(relayToken.value)
  const got = Buffer.from((req.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim())
  if (want.length === 0 || got.length !== want.length) return false
  return crypto.timingSafeEqual(got, want)
}

/** A refused key retries about once a second: say so once per key per 10 minutes. */
const refusedLogged = new Map<string, number>()
function logRefused(id: string): void {
  const now = Date.now()
  const at = refusedLogged.get(id)
  if (at !== undefined && now - at < 10 * 60_000) return
  if (refusedLogged.size > 1000) refusedLogged.clear()
  refusedLogged.set(id, now)
  log.web.info('net: relay refused an endpoint that is not a member', { id: id.slice(0, 64) })
}

netV1Router.post('/net/relay-access', guard(async (req, res) => {
  // This box itself, not proxied (Caddy adds X-Forwarded-For to what it carries in from
  // outside) and not a self-call for someone else, and with the relay's token.
  if (!isLocalOrigin(requestOrigin(req)) || !relayTokenOk(req)) return fail(res, 403, 'relay_only', 'Only the relay on this box asks this')
  const id = String(req.get('x-iroh-endpoint-id') ?? '').toLowerCase()
  const ok = validNetId(id) && isMember(id)
  if (!ok) logRefused(id)
  res.type('text/plain').send(ok ? 'true' : 'false')
}, { ownerOnly: false }))

/**
 * The invite link: a shell script for `curl ... | sh`, or with /windows a PowerShell one for
 * `irm ... | iex` (the code is checked, never used, here).
 */
async function joinPage(req: Request, res: Response, next: NextFunction, windows: boolean): Promise<void> {
  try {
    if (!isCompanion()) return next()
    // A refusal is a script that says why, sent as 200: `curl -f` prints only its own
    // error for any other status, and the user would never read the reason. In PowerShell
    // it writes and stops without `exit`, which would close the user's window.
    const type = windows ? 'text/plain' : 'text/x-shellscript'
    const refuse = (why: string) => {
      res.setHeader('Cache-Control', 'no-store')
      res.type(type).send(windows ? `Write-Host '${why.replace(/'/g, "''")}' -ForegroundColor Red\n` : `echo "${why}" >&2; exit 1\n`)
    }
    const rl = await rateLimited(req)
    if (rl.limited) return refuse('Too many wrong codes. Wait a minute, then try again.')
    const code = String(req.params.code ?? '')
    if (!peekInvite(code)) {
      rl.record()
      return refuse('This invite is not valid any more (used, or older than 10 minutes). Make a new one on your Mac.')
    }
    res.setHeader('Cache-Control', 'no-store')
    const input = { origin: originOf(req), code }
    res.type(type).send(windows ? joinScriptWindows(input) : joinScript(input))
  } catch (err) {
    next(err)
  }
}
netJoinPageRouter.get('/join/:code', (req, res, next) => { void joinPage(req, res, next, false) })
netJoinPageRouter.get('/join/:code/windows', (req, res, next) => { void joinPage(req, res, next, true) })
