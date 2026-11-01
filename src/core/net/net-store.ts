/**
 * The host network's member list and invites, kept by the cloud companion (the user,
 * 2026-11-01: the companion is always on, holds the relay, and is the one that checks a
 * join; docs/reference/host-network.md).
 *
 * A member is one machine's network id (its public key) with a name and a role: `mac`
 * (the Mac that owns this companion; every daemon lets it in) or `host` (a machine that
 * joined with an invite). The list is a state file of this companion, outside its synced
 * data dir: the Mac reads it over the API and hands each machine its copy, and keeps
 * its own copy as its host rows (it puts a lost machine back, net-mac.ts). The relay runs
 * on the companion too, so while the companion is down no one joins, a link already up
 * directly stays up, and a new link needs the relay back.
 *
 * An invite is one use and lives 10 minutes, in memory only: only its hash is held, and a
 * companion restart drops every open invite (make a new one). A wrong code counts toward
 * the caller's auth rate limit (routes/net-v1.ts).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const INVITE_TTL_MS = 10 * 60_000
const MAX_OPEN_INVITES = 8
/** A used invite is still answered this long, so the Mac's watch sees who joined. */
const USED_KEPT_MS = 30 * 60_000
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const ID_RE = /^[0-9a-f]{64}$/
/** Names a machine may take: a plain host alias, never this Mac's own or the cloud box's. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/
const RESERVED = new Set(['local', '__local__', '__cloudbox__', 'cloud', 'companion', 'mac'])
const MAX_MEMBERS = 128

export type NetRole = 'mac' | 'host'

export interface NetMember {
  id: string
  name: string
  role: NetRole
  platform?: string
  addedAt: number
}

export class NetStoreError extends Error {
  constructor(public status: 400 | 404 | 409 | 429 | 500, public code: string, message: string) {
    super(message)
    this.name = 'NetStoreError'
  }
}

export function validNetId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

export function validMemberName(name: unknown): name is string {
  return typeof name === 'string' && NAME_RE.test(name) && !RESERVED.has(name.toLowerCase())
}

/** A machine's own host name, made into a member name (dots and spaces kept out). */
export function memberNameFrom(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : ''
  const base = s.split('.')[0].replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return base && validMemberName(base) ? base : 'machine'
}

/** Where the list lives on the companion: its own state, never the synced data dir. */
export function netStoreFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WALNUT_NET_STORE_FILE) return env.WALNUT_NET_STORE_FILE
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(os.homedir(), '.local', 'state')
  return path.join(state, 'open-walnut', 'net-members.json')
}

/**
 * No file is an empty list; a file that cannot be read is an error, never an empty list:
 * the Mac would read that as every machine removed, and a write would make it so.
 */
function readMembers(file: string): NetMember[] {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new NetStoreError(500, 'store_unreadable', `The machine list cannot be read: ${(err as Error).message}`)
  }
  let raw: { version?: number; members?: unknown }
  try { raw = JSON.parse(text) as typeof raw } catch {
    throw new NetStoreError(500, 'store_unreadable', `The machine list (${file}) is not valid JSON`)
  }
  if (!raw || !Array.isArray(raw.members)) throw new NetStoreError(500, 'store_unreadable', `The machine list (${file}) has no members array`)
  return raw.members.filter((m): m is NetMember => !!m && typeof m === 'object' && validNetId((m as NetMember).id)
    && typeof (m as NetMember).name === 'string' && ((m as NetMember).role === 'mac' || (m as NetMember).role === 'host'))
}

function writeMembers(file: string, members: NetMember[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, members }, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function listMembers(file = netStoreFile()): NetMember[] {
  return readMembers(file)
}

export function isMember(id: string, file = netStoreFile()): boolean {
  return readMembers(file).some((m) => m.id === id)
}

/** The Mac says its id (one `mac` member: a new id replaces the old one). */
export function setMacMember(input: { id: unknown; name?: unknown }, now = Date.now(), file = netStoreFile()): NetMember {
  if (!validNetId(input.id)) throw new NetStoreError(400, 'bad_id', 'endpointId must be 64 hex characters')
  const members = readMembers(file).filter((m) => m.role !== 'mac' && m.id !== input.id)
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 60) : 'Mac'
  const mac: NetMember = { id: input.id, name, role: 'mac', addedAt: now }
  writeMembers(file, [mac, ...members])
  return mac
}

/**
 * The owner Mac puts back a machine it still has (a companion rebuilt without its state
 * forgets the list; the Mac's host rows are the copy). A member already there stays as it is.
 */
export function restoreHostMember(input: { id: unknown; name?: unknown; platform?: unknown }, now = Date.now(), file = netStoreFile()): { member: NetMember; restored: boolean } {
  if (!validNetId(input.id)) throw new NetStoreError(400, 'bad_id', 'endpointId must be 64 hex characters')
  const members = readMembers(file)
  const existing = members.find((m) => m.id === input.id)
  if (existing?.role === 'mac') throw new NetStoreError(409, 'is_mac', 'That id is the Mac')
  if (existing) return { member: existing, restored: false }
  if (members.length >= MAX_MEMBERS) throw new NetStoreError(409, 'too_many_members', `At most ${MAX_MEMBERS} machines`)
  const name = freeName(validMemberName(input.name) ? input.name : 'machine', members, input.id)
  const platform = typeof input.platform === 'string' ? input.platform.slice(0, 40) : undefined
  const member: NetMember = { id: input.id, name, role: 'host', ...(platform ? { platform } : {}), addedAt: now }
  writeMembers(file, [...members, member])
  return { member, restored: true }
}

export function removeMember(id: string, file = netStoreFile()): boolean {
  const members = readMembers(file)
  const next = members.filter((m) => m.id !== id || m.role === 'mac')
  if (next.length === members.length) return false
  writeMembers(file, next)
  return true
}

/** A name not taken yet: `name`, else `name-2`, `name-3`, ... */
function freeName(name: string, members: NetMember[], id: string): string {
  const taken = new Set(members.filter((m) => m.id !== id).map((m) => m.name.toLowerCase()))
  if (!taken.has(name.toLowerCase())) return name
  for (let i = 2; i < 100; i++) {
    const n = `${name.slice(0, 58)}-${i}`
    if (!taken.has(n.toLowerCase())) return n
  }
  throw new NetStoreError(409, 'name_taken', `Too many machines named ${name}`)
}

interface Invite {
  id: string
  hash: string
  /** The name the user asked for, or none: the machine's own host name then. */
  name?: string
  expiresAt: number
  used?: { at: number; memberId: string; name: string; platform?: string }
}

const invites = new Map<string, Invite>()

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

function sweep(now: number): void {
  for (const [id, inv] of invites) {
    if (inv.used ? now - inv.used.at > USED_KEPT_MS : now > inv.expiresAt) invites.delete(id)
  }
}

/** The code as a person types it: any case, dashes and spaces optional. */
export function normalInviteCode(s: unknown): string | null {
  if (typeof s !== 'string') return null
  const t = s.toUpperCase().replace(/[\s-]/g, '')
  return t.length === 12 && [...t].every((c) => ALPHABET.includes(c)) ? t : null
}

export function makeInvite(input: { name?: unknown }, now = Date.now()): { id: string; code: string; expiresAt: number; name?: string } {
  sweep(now)
  let name: string | undefined
  if (input.name !== undefined && input.name !== null && input.name !== '') {
    if (!validMemberName(input.name)) throw new NetStoreError(400, 'bad_name', 'Name the machine with letters, digits, dot, dash or underscore.')
    name = input.name
  }
  const open = [...invites.values()].filter((i) => !i.used && now <= i.expiresAt)
  if (open.length >= MAX_OPEN_INVITES) throw new NetStoreError(429, 'too_many_invites', 'Too many open invites; let one expire or use one first.')
  // 12 characters of 32: 60 bits, one use, 10 minutes, rate limited.
  const raw = Array.from(crypto.randomBytes(12), (b) => ALPHABET[b & 31]).join('')
  const id = `ni-${crypto.randomBytes(9).toString('base64url')}`
  const expiresAt = now + INVITE_TTL_MS
  invites.set(id, { id, hash: sha(raw), ...(name ? { name } : {}), expiresAt })
  return { id, code: `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`, expiresAt, ...(name ? { name } : {}) }
}

/** An open invite for this code (does not use it), or null. */
export function peekInvite(code: unknown, now = Date.now()): { id: string; name?: string; expiresAt: number } | null {
  sweep(now)
  const norm = normalInviteCode(code)
  if (!norm) return null
  const h = Buffer.from(sha(norm), 'hex')
  for (const inv of invites.values()) {
    if (inv.used || now > inv.expiresAt) continue
    if (crypto.timingSafeEqual(h, Buffer.from(inv.hash, 'hex'))) return { id: inv.id, ...(inv.name ? { name: inv.name } : {}), expiresAt: inv.expiresAt }
  }
  return null
}

/**
 * Use an invite: the machine with `endpointId` becomes a `host` member under the
 * invite's name (or its own host name). One use: taken before the write, so two
 * joins with one code cannot both get in.
 */
export function redeemInvite(input: { code: unknown; endpointId: unknown; hostname?: unknown; platform?: unknown }, now = Date.now(), file = netStoreFile()): NetMember {
  if (!validNetId(input.endpointId)) throw new NetStoreError(400, 'bad_id', 'endpointId must be 64 hex characters')
  const peek = peekInvite(input.code, now)
  if (!peek) throw new NetStoreError(400, 'invalid_code', 'This invite is not valid any more (used, or older than 10 minutes). Make a new one on your Mac.')
  const inv = invites.get(peek.id)!
  inv.used = { at: now, memberId: input.endpointId, name: '' }
  try {
    const members = readMembers(file)
    const existing = members.find((m) => m.id === input.endpointId)
    if (existing?.role === 'mac') throw new NetStoreError(409, 'is_mac', 'That machine is this Mac; it is a member already.')
    if (members.length >= MAX_MEMBERS && !existing) throw new NetStoreError(409, 'too_many_members', `At most ${MAX_MEMBERS} machines`)
    const name = freeName(inv.name ?? memberNameFrom(input.hostname), members, input.endpointId)
    const platform = typeof input.platform === 'string' ? input.platform.slice(0, 40) : undefined
    const member: NetMember = { id: input.endpointId, name, role: 'host', ...(platform ? { platform } : {}), addedAt: now }
    writeMembers(file, [...members.filter((m) => m.id !== input.endpointId), member])
    inv.used = { at: now, memberId: member.id, name, ...(platform ? { platform } : {}) }
    return member
  } catch (err) {
    // Not joined: the code stays good while it has not expired.
    delete inv.used
    throw err
  }
}

export function inviteStatus(id: string, now = Date.now()): { state: 'waiting' | 'joined' | 'expired'; expiresAt: number; member?: { id: string; name: string; platform?: string } } {
  sweep(now)
  const inv = invites.get(id)
  if (!inv) throw new NetStoreError(404, 'unknown_invite', 'No such invite (it may have expired)')
  if (inv.used) return { state: 'joined', expiresAt: inv.expiresAt, member: { id: inv.used.memberId, name: inv.used.name, ...(inv.used.platform ? { platform: inv.used.platform } : {}) } }
  return { state: now > inv.expiresAt ? 'expired' : 'waiting', expiresAt: inv.expiresAt }
}

/** Tests. */
export function resetInvitesForTest(): void {
  invites.clear()
}
