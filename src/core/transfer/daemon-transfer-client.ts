/**
 * The server's thin client for the daemon side of a workspace move: every
 * function names a host alias ('__local__' is this machine) and sends ONE daemon
 * command there, gated on the capability that command needs. The work itself
 * (packing, verifying, ssh/scp, probing) runs in that host's daemon
 * (transfer-core.ts, transfer-pack-core.ts, host-facts-core.ts).
 *
 * relayFile is the one loop that lives here: when the receiving host cannot
 * reach the sending one, the server reads the file in chunks from A
 * (fs.readRange) and writes them to B (fs.writePart), resuming from B's `have`
 * after a gap and retrying a chunk up to 3 times; the final chunk carries the
 * size and sha256 B checks before the file appears.
 */

import crypto from 'node:crypto'
import { DaemonNeedsUpgradeError } from '../daemon-file-reader.js'
import type { PackReply, PackMeta, PackFile, PackUntracked, ScanReply, ApplyReply } from '../../providers/transfer-pack-core.js'
import type { WritePartReply, ReachReply, FetchReply, FetchFileResult } from '../../providers/transfer-core.js'
import type { HostFacts, HostLoad } from '../../providers/host-facts-core.js'

export type { PackReply, PackMeta, PackFile, PackUntracked, ScanReply, ApplyReply, WritePartReply, ReachReply, FetchReply, FetchFileResult, HostFacts, HostLoad }

export const TRANSFER_CAPABILITY = 'transfer-v1'
export const WRITE_PART_CAPABILITY = 'fs-write-part-v1'
export const HOST_FACTS_CAPABILITY = 'host-facts-v1'
/** transfer.scan / transfer.apply and pack's `paths` / `exclude` / `asDir`. */
export const TASK_MOVE_CAPABILITY = 'task-move-v1'
export const HOST_LOAD_CAPABILITY = 'host-load-v1'
/** fs.writePart `private: true`: the transcript stage a Claude to Claude transfer resumes from. */
export const PRIVATE_STAGE_CAPABILITY = 'transfer-private-v1'
/** fs.readRange is a required capability; named here so a fake can leave it out. */
const READ_RANGE_CAPABILITY = 'fs.readRange'

const PACK_RPC_MS = 10 * 60_000
const PART_RPC_MS = 60_000
const READ_RPC_MS = 60_000
const FACTS_RPC_MS = 20_000
const DIAL_WAIT_MS = 20_000
/** fs.readRange and fs.writePart both stop at 4 MB per call. */
const MAX_CHUNK_BYTES = 4 * 1024 * 1024

/** What this module needs from a daemon connection. */
export interface TransferConn {
  hasCapability(cap: string): boolean
  send(cmd: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
}

/** The host is not connected (and could not be dialed in time). */
export class TransferHostOfflineError extends Error {
  constructor(public host: string) {
    super(`Walnut is not connected to ${host === '__local__' ? 'this Mac' : host} right now.`)
    this.name = 'TransferHostOfflineError'
  }
}

/** A daemon answered `ok:false`: its message (without the command prefix), code and extra fields. */
export class TransferCommandError extends Error {
  constructor(message: string, public host: string, public command: string, public code: string, public data: Record<string, unknown> = {}) {
    super(message)
    this.name = 'TransferCommandError'
  }
}

/** Every connected daemon of a host (a host can hold more than one link). */
export type TransferConnectionResolver = (host: string) => Promise<TransferConn[]>

let resolver: TransferConnectionResolver = defaultResolver

/** Test-only: swap how a host alias becomes daemon connections. */
export function __setTransferConnectionResolverForTesting(next: TransferConnectionResolver | null): void {
  resolver = next ?? defaultResolver
}

async function defaultResolver(host: string): Promise<TransferConn[]> {
  const dc = await import('../../providers/daemon-connection.js')
  const pick = (): TransferConn[] => (dc.listConnectedDaemonsByHost().get(host) ?? []) as unknown as TransferConn[]
  const conns = pick()
  if (conns.length > 0) return conns
  let target: { hostname: string; user?: string; port?: number } | null = null
  const { isSelfHost } = await import('../../replica/self-host.js')
  if (host === '__local__' || isSelfHost(host)) {
    target = { hostname: host }
  } else {
    const { getConfig } = await import('../config-manager.js')
    const def = (await getConfig()).hosts?.[host] as { hostname?: string; ssh?: string; user?: string; port?: number } | undefined
    const hostname = def?.hostname ?? def?.ssh
    if (def && hostname) target = { hostname, user: def.user, port: def.port }
  }
  if (!target) return []
  let timer: NodeJS.Timeout | undefined
  const dial = dc.getDaemonConnection(host, target)
  dial.catch(() => { /* the pool keeps the failure */ })
  try {
    const conn = await Promise.race([
      dial,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('dial timeout')), DIAL_WAIT_MS) }),
    ])
    const after = pick()
    return after.length > 0 ? after : conn.connected ? [conn as unknown as TransferConn] : []
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

async function connectionFor(host: string, capability: string): Promise<TransferConn> {
  const conns = await resolver(host)
  if (conns.length === 0) throw new TransferHostOfflineError(host)
  const able = conns.find((c) => c.hasCapability(capability))
  if (!able) throw new DaemonNeedsUpgradeError(host, capability)
  return able
}

async function call<T>(host: string, capability: string, command: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const conn = await connectionFor(host, capability)
  const res = await conn.send(command, params, timeoutMs)
  if (res.ok === false) {
    const { ok: _ok, id: _id, error, code, ...data } = res
    const message = String(error ?? command + ' failed').replace(command + ' failed: ', '')
    throw new TransferCommandError(message, host, command, typeof code === 'string' ? code : 'failed', data)
  }
  const { ok: _ok, id: _id, ...rest } = res
  return rest as T
}

export interface PackOptions {
  cwd: string; outDir: string; maxUntrackedBytes?: number; maxTarBytes?: number; timeoutMs?: number
  /** Only these repository paths' changes ride ('task-move-v1'). */
  paths?: string[]
  /** A folder pack leaves these relative folders out ('task-move-v1'). */
  exclude?: string[]
  /** Pack as a plain folder even inside a repository ('task-move-v1'). */
  asDir?: boolean
}

/** Pack the workspace at `cwd` on `host` into `outDir` there (meta.json and friends). */
export function packWorkspace(host: string, opts: PackOptions): Promise<PackReply> {
  const { timeoutMs, ...params } = opts
  const moveOptions = params.paths !== undefined || params.exclude !== undefined || params.asDir !== undefined
  return call<PackReply>(host, moveOptions ? TASK_MOVE_CAPABILITY : TRANSFER_CAPABILITY, 'transfer.pack', params, timeoutMs ?? PACK_RPC_MS)
}

/** Whether `host` runs the move steps itself (scan, limited packs, apply). */
/** The host's daemon has 'task-move-v1'. A host that is offline throws (it is not an old daemon). */
export async function hostCanMove(host: string): Promise<boolean> {
  try { await connectionFor(host, TASK_MOVE_CAPABILITY); return true } catch (err) {
    if (err instanceof DaemonNeedsUpgradeError) return false
    throw err
  }
}

/** The git repositories and loose files in `dir` on `host`. */
export function scanWorkDir(host: string, dir: string): Promise<ScanReply> {
  return call<ScanReply>(host, TASK_MOVE_CAPABILITY, 'transfer.scan', { dir }, 60_000)
}

/** Set the pack in `bundleDir` up as a working checkout at `dest` on `host`. */
export function applyPack(host: string, opts: { dest: string; bundleDir: string; cloneFrom?: string; url?: string; timeoutMs?: number }): Promise<ApplyReply> {
  const { timeoutMs, ...params } = opts
  return call<ApplyReply>(host, TASK_MOVE_CAPABILITY, 'transfer.apply', params, timeoutMs ?? 12 * 60_000)
}

/** How busy `host` is now (load, CPU, memory, disk under `path`). */
export function probeHostLoad(host: string, opts: { path?: string; timeoutMs?: number } = {}): Promise<HostLoad> {
  return call<HostLoad>(host, HOST_LOAD_CAPABILITY, 'host.load', opts.path ? { path: opts.path } : {}, opts.timeoutMs ?? 8_000)
}

export interface WritePartOptions {
  path: string; offset: number; data: Buffer | string; final?: boolean; size?: number; sha256?: string
  /** A private stage part ('transfer-private-v1'): the attempt's 32-hex token. */
  attempt?: string
}

/** One chunk of a file onto `host` (data as bytes, or as base64 text already). */
export function writePart(host: string, opts: WritePartOptions): Promise<WritePartReply> {
  const { attempt, ...rest } = opts
  const data = typeof opts.data === 'string' ? opts.data : opts.data.toString('base64')
  if (attempt !== undefined) {
    return call<WritePartReply>(host, PRIVATE_STAGE_CAPABILITY, 'fs.writePart', { ...rest, data, private: true, attempt }, PART_RPC_MS)
  }
  return call<WritePartReply>(host, WRITE_PART_CAPABILITY, 'fs.writePart', { ...rest, data }, PART_RPC_MS)
}

export const UPLOAD_PART_CAPABILITY = 'upload-part-v1'

export interface UploadPartOptions {
  uploadId: string; name: string; size: number; offset: number; data: Buffer
  sha256?: string; taskId?: string; home?: string
  /** The host prefers the task it started this session for over `taskId`. */
  sessionId?: string
}

/** One chunk of a phone's session upload onto `host` ('upload-part-v1'); the daemon picks the path. */
export function uploadPart(host: string, opts: UploadPartOptions): Promise<WritePartReply> {
  return call<WritePartReply>(host, UPLOAD_PART_CAPABILITY, 'upload.part', { ...opts, data: opts.data.toString('base64') }, PART_RPC_MS)
}

/** Refuses unless `host` can hold a private stage; nothing is read or sent. */
export async function assertPrivateStage(host: string): Promise<void> {
  await connectionFor(host, PRIVATE_STAGE_CAPABILITY)
}

/**
 * Where a session's Claude transcript is on `host`, told apart honestly: the host
 * did not answer, it has none, it has exactly one, or it has several (then no
 * file is "the" transcript). Searches the default root, which a daemon walks
 * together with its own CLAUDE_CONFIG_DIR one (an older daemon: the default only).
 */
export type TranscriptLookup =
  | { kind: 'unreachable'; error: string }
  | { kind: 'none' }
  | { kind: 'one'; path: string }
  | { kind: 'many'; paths: string[] }

export async function findTranscript(host: string, sessionId: string): Promise<TranscriptLookup> {
  let res: Record<string, unknown>
  try {
    const conns = await resolver(host)
    if (conns.length === 0) return { kind: 'unreachable', error: new TransferHostOfflineError(host).message }
    res = await conns[0].send('fs.find', { path: '~/.claude/projects', name: sessionId + '.jsonl', maxDepth: 3 }, READ_RPC_MS)
  } catch (err) {
    return { kind: 'unreachable', error: err instanceof Error ? err.message : String(err) }
  }
  if (res.ok === false) return { kind: 'unreachable', error: String(res.error ?? 'fs.find failed') }
  const files = Array.isArray(res.files) ? (res.files as unknown[]).filter((f): f is string => typeof f === 'string') : []
  if (files.length === 0) return { kind: 'none' }
  if (files.length === 1) return { kind: 'one', path: files[0] }
  return { kind: 'many', paths: files }
}

/** Where a receiving host should reach the sending one over its own ssh. */
export interface SshPeer { host: string; user?: string; port?: number }

/** Can `host` ssh to `target` on its own (BatchMode, no prompt)? */
export function reachHost(host: string, target: SshPeer & { timeoutMs?: number }): Promise<ReachReply> {
  const wait = (target.timeoutMs ?? 8000) + 10_000
  return call<ReachReply>(host, TRANSFER_CAPABILITY, 'transfer.reach', { ...target }, wait)
}

export interface FetchOptions extends SshPeer {
  files: Array<{ remotePath: string; localPath: string; size?: number; sha256?: string }>
  timeoutMs?: number
}

/** Have `host` pull files from `opts.host` with scp, each verified before it lands. */
export async function fetchFromHost(host: string, opts: FetchOptions): Promise<FetchReply> {
  const wait = (opts.timeoutMs ?? 600_000) + 30_000
  const reply = await call<Partial<FetchReply>>(host, TRANSFER_CAPABILITY, 'transfer.fetch', { ...opts }, wait)
  // call() drops the RPC's `ok`, which is also this reply's verdict: read it back
  // from the files (2026-10-21: every direct copy that worked was taken for a
  // failure, recorded as "copy failed", and sent through Walnut instead).
  const results = Array.isArray(reply.results) ? reply.results : []
  return { ...reply, results, ok: results.length > 0 && results.every((r) => r.ok) }
}

/** The path as the kernel on `host` names it (symlinks resolved). */
export async function realpathOn(host: string, path: string): Promise<string> {
  return (await call<{ path: string }>(host, TRANSFER_CAPABILITY, 'transfer.realpath', { path }, 15_000)).path
}

/** What `host` is (OS, toolchains, cloud, ...); `network:false` skips the network probes. */
export function probeHostFacts(host: string, opts: { network?: boolean } = {}): Promise<HostFacts> {
  return call<HostFacts>(host, HOST_FACTS_CAPABILITY, 'host.facts', { ...opts }, FACTS_RPC_MS)
}

export interface RelayOptions {
  /** The file's size; absent = the size the first fs.readRange reports. */
  size?: number
  /** The file's sha256; absent = hashed here from the bytes as they are relayed. */
  sha256?: string
  chunkBytes?: number
  /** Called after each chunk B acknowledged. */
  onProgress?: (p: { sent: number; total: number }) => void
  /** Tries per chunk (default 3). */
  retries?: number
  retryDelayMs?: number
  /** Write a private stage on the receiver ('transfer-private-v1') under this attempt's token. */
  privateAttempt?: string
  /** Called with the bytes the receiver acknowledged, in file order, each byte once. */
  onBytes?: (bytes: Buffer) => void
}

export interface RelayResult { bytes: number; sha256: string; chunks: number; retries: number; path?: string }

async function readChunk(host: string, path: string, start: number, length: number): Promise<{ data: string; bytesRead: number; fileSize: number }> {
  const conn = await connectionFor(host, READ_RANGE_CAPABILITY)
  const res = await conn.send('fs.readRange', { path, start, length }, READ_RPC_MS)
  if (res.ok === false) {
    throw new TransferCommandError(String(res.error ?? 'fs.readRange failed'), host, 'fs.readRange', 'read_failed')
  }
  return { data: String(res.data ?? ''), bytesRead: Number(res.bytesRead ?? 0), fileSize: Number(res.fileSize ?? -1) }
}

// A refusal from either daemon (not a dropped link) is final: retrying gets the same answer.
const FINAL_CODES = ['size_mismatch', 'checksum_mismatch', 'source_changed', 'read_failed', 'bad_request', 'too_large',
  // A private stage's refusals: retrying gets the same answer.
  'not_owner', 'not_supported', 'topology_unknown', 'not_private_path', 'root_unsafe', 'stage_changed',
  'stage_foreign', 'stage_incomplete', 'target_exists']

/**
 * Copy one file from `fromHost` to `toHost` through this server, in chunks.
 * Resumes from the receiver's `have` after a gap; any other failure of a chunk
 * (a dropped link, a timeout) is retried up to `retries` times. A size or
 * checksum refusal from the receiver is final, and so is a source whose size
 * changed under the relay.
 *
 * Without `sha256` the digest is built from the relayed bytes in file order:
 * only the bytes past what is already hashed are added, and only once the
 * receiver acknowledged them, so a retried chunk or a resume from an earlier
 * offset never hashes a byte twice. The final chunk carries it, so the
 * receiver still verifies what it got against what was sent.
 */
export async function relayFile(fromHost: string, fromPath: string, toHost: string, toPath: string, opts: RelayOptions): Promise<RelayResult> {
  let total: number | null = typeof opts.size === 'number' ? opts.size : null
  const chunk = Math.max(1, Math.min(opts.chunkBytes ?? 1024 * 1024, MAX_CHUNK_BYTES))
  const tries = Math.max(1, opts.retries ?? 3)
  const delay = opts.retryDelayMs ?? 500
  const hasher = opts.sha256 ? null : crypto.createHash('sha256')
  let hashedTo = 0
  let deliveredTo = 0
  // Both ends are checked up front, so a missing capability fails before any byte moves.
  await connectionFor(toHost, opts.privateAttempt !== undefined ? PRIVATE_STAGE_CAPABILITY : WRITE_PART_CAPABILITY)
  await connectionFor(fromHost, READ_RANGE_CAPABILITY)
  let offset = 0
  let chunks = 0
  let retried = 0
  let failures = 0
  let lastError: unknown = null
  for (;;) {
    try {
      let bytes = Buffer.alloc(0)
      // An empty file is read once too, so a source that is not empty after all is caught.
      if (total === null || total - offset > 0 || offset === 0) {
        const left = total === null ? 0 : total - offset
        const got = await readChunk(fromHost, fromPath, offset, left > 0 ? Math.min(chunk, left) : chunk)
        if (!(got.fileSize >= 0)) throw new TransferCommandError(`${fromPath}: no file size in the read reply`, fromHost, 'fs.readRange', 'read_failed')
        if (total === null) total = got.fileSize
        if (got.fileSize !== total) throw new TransferCommandError(`${fromPath} is ${got.fileSize} bytes now, expected ${total}`, fromHost, 'fs.readRange', 'source_changed')
        const want = Math.min(chunk, total - offset)
        if (got.bytesRead !== want) throw new Error(`short read at ${offset}: ${got.bytesRead} of ${want} bytes`)
        bytes = Buffer.from(got.data, 'base64')
        if (bytes.length !== want) throw new Error(`read at ${offset} decoded to ${bytes.length} of ${want} bytes`)
      }
      const final = offset + bytes.length >= total
      // The part of this chunk not hashed yet (none on a re-send below hashedTo).
      const fresh = hasher && offset + bytes.length > hashedTo ? bytes.subarray(hashedTo - offset) : null
      const sha256 = !final ? undefined : hasher ? (fresh ? hasher.copy().update(fresh) : hasher.copy()).digest('hex') : opts.sha256
      const reply = await writePart(toHost, {
        path: toPath, offset, data: bytes, ...(final ? { final: true, size: total, sha256 } : {}),
        ...(opts.privateAttempt !== undefined ? { attempt: opts.privateAttempt } : {}),
      })
      chunks++
      failures = 0
      if (hasher && fresh && !final) { hasher.update(fresh); hashedTo = offset + bytes.length }
      if (opts.onBytes && offset + bytes.length > deliveredTo) {
        opts.onBytes(bytes.subarray(deliveredTo - offset))
        deliveredTo = offset + bytes.length
      }
      offset += bytes.length
      opts.onProgress?.({ sent: offset, total })
      if (final) return { bytes: reply.staged, sha256: reply.sha256 ?? sha256 ?? '', chunks, retries: retried, ...(reply.path ? { path: reply.path } : {}) }
    } catch (err) {
      if (err instanceof TransferCommandError && err.command === 'fs.writePart' && err.code === 'gap') {
        // The receiver lost bytes (a restart, a cleared staging file): resume where it stands.
        const have = Number(err.data.have)
        offset = Number.isFinite(have) && have >= 0 && have < offset ? have : 0
      } else if ((err instanceof TransferCommandError && FINAL_CODES.includes(err.code)) || err instanceof DaemonNeedsUpgradeError) {
        throw err
      }
      lastError = err
      failures++
      retried++
      // A receiver that keeps losing what it took would loop forever on gaps alone.
      if (failures >= tries || retried > tries * 10) throw lastError
      if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    }
  }
}
