/**
 * walnut-net's control socket and the files around it, without the supervisor (net-core.ts):
 * where the socket goes, one request on it, the atomic write of its 0600 files, and the checks
 * the daemon's `net.invites` and `net.join` run on what the server sent. The supervisor and a
 * host's `walnut daemon net-id|net-forget` (service-set-net.ts) share them.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { ID_RE } from './net-config-core.js'

const CONTROL_TIMEOUT_MS = 30_000
/** A unix socket path must fit sockaddr_un (104 bytes on macOS, 108 on Linux). */
const SOCKET_PATH_MAX = 100

/** The control protocol that has `invites` and `join` (and reads `relayMode`). */
export const JOIN_PROTOCOL = 2
export const OLD_NET = "This host's walnut-net is older than this Walnut and cannot take a machine in yet; it moves to the new version once that is downloaded."
export const OLD_NET_RELAY = "This host's walnut-net is older than this Walnut and cannot use public relays or no relay yet; it moves to the new version once that is downloaded."
export const OLD_NET_RELAY_RETRY = "This host's walnut-net is older than this Walnut and cannot use public relays or no relay; the new version is downloading, so try again in a minute."

export interface NetStatus {
  /** A walnut-net executable exists here. */
  available: boolean
  /** A config exists (the server turned the network on for this host). */
  enabled: boolean
  running: boolean
  pid: number | null
  /** This host's endpoint id (its public key), once its key exists. (Not `id`: that is the RPC's.) */
  endpointId: string | null
  restarts: number
  lastExit: { code: number | null; signal: string | null; at: number } | null
  lastError: string | null
  /** walnut-net's own status (relays, peers and their paths), when it answered. */
  node: Record<string, unknown> | null
  /** The running walnut-net's control protocol (its ready line; 3 takes phones, Walnut Connect). Absent from an older daemon. */
  protocol?: number
}

/** The endpoint id of the key in `keyFile` (`walnut-net id`), making the key on first use (no network needed). */
export async function netKeyId(spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess, bin: string, keyFile: string): Promise<string> {
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn(bin, ['id', '--key', keyFile], { stdio: ['ignore', 'pipe', 'pipe'] })
    let o = ''
    let e = ''
    p.stdout?.on('data', (d: Buffer) => { o += d.toString() })
    p.stderr?.on('data', (d: Buffer) => { e += d.toString() })
    p.on('error', reject)
    p.on('exit', (code) => code === 0 ? resolve(o) : reject(new Error(`walnut-net id failed: ${e.trim().slice(-300)}`)))
  })
  const got = (JSON.parse(out.trim()) as { id?: string }).id
  if (!got || !ID_RE.test(got)) throw new Error('walnut-net id answered no id')
  return got
}

/** The control socket: inside the state dir when the path fits, else a 0700 dir in /tmp. */
export function netControlPath(stateDir: string, uid = process.getuid?.() ?? 0, tmp = '/tmp'): string {
  const inside = path.join(stateDir, 'ctl.sock')
  if (Buffer.byteLength(inside) <= SOCKET_PATH_MAX) return inside
  const hash = crypto.createHash('sha256').update(path.resolve(stateDir)).digest('hex').slice(0, 16)
  return path.join(tmp, `walnut-net-${uid}`, `${hash}.sock`)
}

/** A private dir for the socket: made 0700, refused when it is someone else's or a link. */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = fs.lstatSync(dir)
  const uid = process.getuid?.()
  if (!st.isDirectory() || st.isSymbolicLink() || (uid !== undefined && st.uid !== uid)) {
    throw new Error(`${dir} is not a directory of this account; refusing to put the network control socket there`)
  }
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700)
}

export function writeFileAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, data, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** walnut-net read a config and refused it (it keeps the one it runs). */
export class NetConfigRefused extends Error {}

/** One JSON request on the control socket, one JSON answer. */
export function netControlCall(socketPath: string, req: Record<string, unknown>, timeoutMs = CONTROL_TIMEOUT_MS): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath)
    let buf = ''
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`walnut-net did not answer ${String(req.op)} in ${timeoutMs} ms`)) }, timeoutMs)
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'))
    sock.on('data', (d: string) => {
      buf += d
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      clearTimeout(timer)
      sock.destroy()
      try { resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>) } catch { reject(new Error('walnut-net answered something that is not JSON')) }
    })
    sock.on('error', (err) => { clearTimeout(timer); reject(err) })
    sock.on('close', () => { clearTimeout(timer); if (!buf.includes('\n')) reject(new Error('walnut-net closed the control socket without an answer')) })
  })
}

/** An endpoint id the server named (`to`), lower case; throws on anything else. */
export function endpointArg(to: unknown): string {
  const id = typeof to === 'string' ? to.toLowerCase() : ''
  if (!ID_RE.test(id)) throw new Error('`to` must be an endpoint id')
  return id
}

/** `net.invites`: the pending set walnut-net checks joins against. Only a hash of each code. */
export function inviteList(raw: unknown): Array<{ id: string; codeHash: string; expiresAt: number; name: string | null }> {
  return (Array.isArray(raw) ? raw.slice(0, 16) : []).map((i) => {
    const o = (i && typeof i === 'object' ? i : {}) as Record<string, unknown>
    if (typeof o.id !== 'string' || !/^[\w-]{1,64}$/.test(o.id)) throw new Error('invite id')
    if (typeof o.codeHash !== 'string' || !ID_RE.test(o.codeHash)) throw new Error('invite codeHash must be 64 hex')
    if (typeof o.expiresAt !== 'number' || !Number.isFinite(o.expiresAt)) throw new Error('invite expiresAt')
    return { id: o.id, codeHash: o.codeHash, expiresAt: o.expiresAt, name: typeof o.name === 'string' && o.name ? o.name.slice(0, 80) : null }
  })
}

export interface JoinAsk { to?: unknown; code?: unknown; hostname?: unknown; platform?: unknown; addrs?: unknown; relay?: unknown; relayMode?: unknown }

/** `net.join`'s words, checked: the control request it sends, and the relay mode it runs the join on. */
export function joinRequest(req: JoinAsk): { control: Record<string, unknown>; to: string; relayMode: 'public' | 'none' | undefined } {
  const to = endpointArg(req.to)
  if (typeof req.code !== 'string' || req.code.length > 32) throw new Error('`code` is required')
  const addrs = (Array.isArray(req.addrs) ? req.addrs.slice(0, 16) : []).filter((a): a is string => typeof a === 'string' && a.length <= 64)
  const relay = typeof req.relay === 'string' && /^https?:\/\/\S{1,500}$/.test(req.relay) ? req.relay : null
  if (req.relayMode !== undefined && req.relayMode !== 'public' && req.relayMode !== 'none') throw new Error('`relayMode` is public or none')
  return {
    to,
    relayMode: req.relayMode as 'public' | 'none' | undefined,
    control: {
      op: 'join', to, code: req.code, addrs, relay,
      hostname: typeof req.hostname === 'string' ? req.hostname.slice(0, 255) : '',
      platform: typeof req.platform === 'string' ? req.platform.slice(0, 40) : '',
    },
  }
}
