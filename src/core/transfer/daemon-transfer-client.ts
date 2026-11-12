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
import { log } from '../../logging/index.js'
import { DaemonNeedsUpgradeError } from '../daemon-file-reader.js'
import { TRANSCRIPT_FIND_DEPTH } from '../claude-config-dir.js'
import type { PackReply, PackMeta, PackFile, PackUntracked, ScanReply, ApplyReply, ClearReply, PackedFile } from '../../providers/transfer-pack-core.js'
import type { WritePartReply, ReachReply, FetchReply, FetchFileResult } from '../../providers/transfer-core.js'
import type { HostFacts, HostLoad, ModelEndpointProbe } from '../../providers/host-facts-core.js'
import { MAX_UPLOAD_FRAME_BYTES } from '../../providers/ssh-upload-budget.js'
import { linkFailureKind } from '../../providers/link-failure.js'
import { awaitLink, currentLinkWait, linkPollMs } from './link-wait.js'
import { partRetry } from './part-retry.js'
import { interruptedByShutdown, isServerStopping } from '../server-stopping.js'

export type { PackReply, PackMeta, PackFile, PackUntracked, ScanReply, ApplyReply, ClearReply, PackedFile, WritePartReply, ReachReply, FetchReply, FetchFileResult, HostFacts, HostLoad, ModelEndpointProbe }

export const TRANSFER_CAPABILITY = 'transfer-v1'
export const WRITE_PART_CAPABILITY = 'fs-write-part-v1'
export const HOST_FACTS_CAPABILITY = 'host-facts-v1'
/** transfer.scan / transfer.apply and pack's `paths` / `exclude` / `asDir`. */
export const TASK_MOVE_CAPABILITY = 'task-move-v1'
export const HOST_LOAD_CAPABILITY = 'host-load-v1'
/** host.endpoint: whether the host reaches its sessions' model endpoint. */
export const MODEL_ENDPOINT_CAPABILITY = 'model-endpoint-v1'
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

// The errors a command answers, and the commands sent again on a lost link (transfer-errors.ts).
export { RESEND_ON_LOST, TransferCommandError, TransferHostOfflineError, TransferServerStoppingError } from './transfer-errors.js'
import { RESEND_ON_LOST, TransferCommandError, TransferHostOfflineError, TransferServerStoppingError } from './transfer-errors.js'

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
  let timer: NodeJS.Timeout | undefined
  // An unknown host rejects and reads as offline (the catch below).
  const dial = (await import('../hosts/link.js')).link(host)
  dial.catch(() => { /* the pool keeps the failure */ })
  try {
    const conn = await Promise.race([
      dial,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('dial timeout')), DIAL_WAIT_MS) }),
    ])
    const after = pick()
    return after.length > 0 ? after : conn.connected ? [conn as unknown as TransferConn] : []
  } catch (err) {
    // A dial this server's stop refused is that stop, never the host away.
    if (interruptedByShutdown(err)) throw new TransferServerStoppingError(host)
    return []
  } finally {
    clearTimeout(timer)
  }
}

/** No link to `host`: the server's own stop when it is stopping, else the host is away. */
function noLink(host: string, waitedMs = 0): Error {
  return isServerStopping() ? new TransferServerStoppingError(host) : new TransferHostOfflineError(host, waitedMs)
}

async function connectionFor(host: string, capability: string): Promise<TransferConn> {
  // No dial while stopping (daemon-dial-gate.ts), and a link found now closes in a moment.
  if (isServerStopping()) throw new TransferServerStoppingError(host)
  let conns = await resolver(host)
  const wait = currentLinkWait()
  if (conns.length === 0 && wait) conns = await awaitLink(host, wait.ms, resolver, () => new TransferServerStoppingError(host))
  if (conns.length === 0) throw noLink(host, wait?.ms ?? 0)
  const able = conns.find((c) => c.hasCapability(capability))
  if (!able) throw new DaemonNeedsUpgradeError(host, capability)
  return able
}

/** Called right before a command leaves for `host`, after its link was found; a throw sends nothing. */
export type SendGate = (host: string, command: string) => void

/** Every command leaves here: a link the server's own stop closed under it reads as that stop. */
async function sendOn(conn: TransferConn, host: string, command: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  try {
    return await conn.send(command, params, timeoutMs)
  } catch (err) {
    if (isServerStopping()) throw new TransferServerStoppingError(host, command)
    throw err
  }
}

async function call<T>(host: string, capability: string, command: string, params: Record<string, unknown>, timeoutMs: number, gate?: SendGate): Promise<T> {
  let res: Record<string, unknown>
  const wait = currentLinkWait()
  const until = Date.now() + (wait?.ms ?? 0)
  let sent = params
  for (let attempt = 1; ; attempt++) {
    const conn = await connectionFor(host, capability)
    try {
      gate?.(host, command)
      res = await sendOn(conn, host, command, sent, timeoutMs)
      break
    } catch (err) {
      // Inside a link wait: a command that never reached the host (a link the pool still listed was
      // gone) goes again once a link is back; one that may have run there (`lost`) only when it is
      // one that can run twice. Outside a wait, and once the wait's bound passed, the error stands.
      const kind = linkFailureKind(err)
      const again = kind === 'lost' ? RESEND_ON_LOST[command] : kind === 'no-link' ? (p: Record<string, unknown>) => p : undefined
      if (!wait || !again || Date.now() >= until) throw err
      sent = again(params, attempt)
      log.session.info('transfer: the link went away under a command; it goes again once the link is back', { host, command, kind, attempt })
      await new Promise((r) => setTimeout(r, linkPollMs()))
    }
  }
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
  /** With `paths`: the sha256 of each file when the session first touched it, so the pack can
   *  tell which files hold only this task's change ('task-move-clear-v1'; older daemons ignore it). */
  ownBefore?: Record<string, string>
  /** A folder pack leaves these relative folders out ('task-move-v1'). */
  exclude?: string[]
  /** Pack as a plain folder even inside a repository ('task-move-v1'). */
  asDir?: boolean
  /** A probe: skip the bundle of a repository no other host can clone, which would carry its
   *  whole history (older daemons ignore it and bundle as before). */
  noFullBundle?: boolean
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

export const TASK_MOVE_CLEAR_CAPABILITY = 'task-move-clear-v1'

/** The host's daemon can clear a moved shared checkout's files ('task-move-clear-v1'). Offline throws. */
export async function hostCanClear(host: string): Promise<boolean> {
  try { await connectionFor(host, TASK_MOVE_CLEAR_CAPABILITY); return true } catch (err) {
    if (err instanceof DaemonNeedsUpgradeError) return false
    throw err
  }
}

/** Back up and clear files a move carried away from a shared checkout on `host`. */
export function clearMovedFiles(host: string, opts: { root: string; files: PackedFile[]; backupFrom: string; backupTo: string }): Promise<ClearReply> {
  return call<ClearReply>(host, TASK_MOVE_CLEAR_CAPABILITY, 'transfer.clear', { ...opts }, 2 * 60_000)
}

/** The git repositories and loose files in `dir` on `host`. */
export function scanWorkDir(host: string, dir: string): Promise<ScanReply> {
  return call<ScanReply>(host, TASK_MOVE_CAPABILITY, 'transfer.scan', { dir }, 60_000)
}

export const TASK_MOVE_INTO_CAPABILITY = 'task-move-into-v1'

/** The host's daemon can set a moved repository up in the checkout it left ('task-move-into-v1'). Offline throws. */
export async function hostCanMoveInto(host: string): Promise<boolean> {
  try { await connectionFor(host, TASK_MOVE_INTO_CAPABILITY); return true } catch (err) {
    if (err instanceof DaemonNeedsUpgradeError) return false
    throw err
  }
}

/**
 * Set the pack in `bundleDir` up as a working checkout at `dest` on `host`. `into`: in the
 * existing checkout there, only while nothing changed in it ('task-move-into-v1').
 */
export function applyPack(host: string, opts: {
  dest: string; bundleDir: string; cloneFrom?: string; url?: string; into?: boolean
  /** `into`: what that copy held when its work left; its uncommitted files are then no change. */
  expect?: { head: string; print: string }; timeoutMs?: number
}): Promise<ApplyReply> {
  const { timeoutMs, ...params } = opts
  return call<ApplyReply>(host, opts.into ? TASK_MOVE_INTO_CAPABILITY : TASK_MOVE_CAPABILITY, 'transfer.apply', params, timeoutMs ?? 12 * 60_000)
}

/** How busy `host` is now (load, CPU, memory, disk under `path`). */
export function probeHostLoad(host: string, opts: { path?: string; timeoutMs?: number } = {}): Promise<HostLoad> {
  return call<HostLoad>(host, HOST_LOAD_CAPABILITY, 'host.load', opts.path ? { path: opts.path } : {}, opts.timeoutMs ?? 8_000)
}

/** Whether `host` reaches the model endpoint a session in `cwd` calls (no tokens spent). */
export function probeModelEndpoint(host: string, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<ModelEndpointProbe> {
  return call<ModelEndpointProbe>(host, MODEL_ENDPOINT_CAPABILITY, 'host.endpoint', opts.cwd ? { cwd: opts.cwd } : {}, opts.timeoutMs ?? 10_000)
}

export interface WritePartOptions {
  path: string; offset: number; data: Buffer | string; final?: boolean; size?: number; sha256?: string
  /** A private stage part ('transfer-private-v1'): the attempt's 32-hex token. */
  attempt?: string
  /** How long to wait for this part's answer (default 60 s); never sent. */
  timeoutMs?: number
}

/**
 * One chunk of a file onto `host` (data as bytes, or as base64 text already). A chunk over
 * MAX_UPLOAD_FRAME_BYTES goes as several parts at their offsets, `final` and `sha256` on the last
 * one only, so no frame outlasts a daemon's keepalive on the paced bulk link.
 */
export async function writePart(host: string, opts: WritePartOptions, gate?: SendGate): Promise<WritePartReply> {
  const { attempt, timeoutMs, final, sha256, data: _data, ...rest } = opts
  const bytes = typeof opts.data === 'string' ? Buffer.from(opts.data, 'base64') : opts.data
  const wait = timeoutMs ?? PART_RPC_MS
  let reply: WritePartReply | null = null
  for (let at = 0; at < bytes.length || reply === null; at += MAX_UPLOAD_FRAME_BYTES) {
    const last = at + MAX_UPLOAD_FRAME_BYTES >= bytes.length
    const params = {
      ...rest, offset: opts.offset + at, data: bytes.subarray(at, at + MAX_UPLOAD_FRAME_BYTES).toString('base64'),
      ...(last && final !== undefined ? { final } : {}), ...(last && sha256 ? { sha256 } : {}),
    }
    reply = attempt !== undefined
      ? await call<WritePartReply>(host, PRIVATE_STAGE_CAPABILITY, 'fs.writePart', { ...params, private: true, attempt }, wait, gate)
      : await call<WritePartReply>(host, WRITE_PART_CAPABILITY, 'fs.writePart', params, wait, gate)
    if (last) break
  }
  return reply!
}

/**
 * A whole file this server holds, written onto `host` in parts, size and sha256 checked on the
 * last one. A failed part goes again as the relay's does (part-retry.ts): inside a link wait, a
 * dropped link is waited out and the write goes on from the receiver's bytes.
 */
export async function writeFileInParts(host: string, path: string, bytes: Buffer, opts: { partBytes?: number; retries?: number; retryDelayMs?: number } = {}): Promise<WritePartReply> {
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  const retry = partRetry({ host, path, size: Math.min(opts.partBytes ?? MAX_UPLOAD_FRAME_BYTES, MAX_UPLOAD_FRAME_BYTES), tries: opts.retries ?? 3, delayMs: opts.retryDelayMs ?? 500 })
  let offset = 0
  for (;;) {
    const end = Math.min(bytes.length, offset + retry.size)
    const final = end >= bytes.length
    try {
      const reply = await writePart(host, { path, offset, data: bytes.subarray(offset, end), ...(final ? { final: true, size: bytes.length, sha256 } : {}) })
      retry.ok()
      if (final) return reply
      offset = end
    } catch (err) {
      offset = await retry.next(err, offset)
    }
  }
}

export const UPLOAD_PART_CAPABILITY = 'upload-part-v1'

export interface UploadPartOptions {
  uploadId: string; name: string; size: number; offset: number; data: Buffer
  sha256?: string; taskId?: string; home?: string
  /** The host prefers the task it started this session for over `taskId`. */
  sessionId?: string
}

/**
 * One chunk of a phone's session upload onto `host` ('upload-part-v1'); the daemon picks the path.
 * A chunk over MAX_UPLOAD_FRAME_BYTES goes as several parts at their offsets (the daemon reads the
 * last one from its length and checks the whole file's sha256 there), so no frame outlasts a
 * daemon's keepalive on the paced bulk link.
 */
export async function uploadPart(host: string, opts: UploadPartOptions): Promise<WritePartReply> {
  const { data, sha256, ...rest } = opts
  let reply: WritePartReply | null = null
  for (let at = 0; at < data.length || reply === null; at += MAX_UPLOAD_FRAME_BYTES) {
    const piece = data.subarray(at, at + MAX_UPLOAD_FRAME_BYTES)
    const last = at + MAX_UPLOAD_FRAME_BYTES >= data.length
    reply = await call<WritePartReply>(host, UPLOAD_PART_CAPABILITY, 'upload.part', {
      ...rest, offset: opts.offset + at, data: piece.toString('base64'), ...(last && sha256 ? { sha256 } : {}),
    }, PART_RPC_MS)
    if (last) break
  }
  return reply!
}

/** Refuses unless `host` can hold a private stage; nothing is read or sent. */
export async function assertPrivateStage(host: string): Promise<void> {
  await connectionFor(host, PRIVATE_STAGE_CAPABILITY)
}

/**
 * One daemon command on `host`, its reply as it came (an `ok:false` refusal
 * included), for a caller that reads the refusal itself (host-copy-paths.ts reads
 * ENOENT / ENOTFILE / ENOTDIR from fs.readRange). Offline and a missing capability throw as above.
 * `gate`, when given, is asked after the dial and right before the send, as in relayFile.
 */
export async function hostCommand(host: string, capability: string, command: string, params: Record<string, unknown>, timeoutMs = READ_RPC_MS, gate?: SendGate): Promise<Record<string, unknown>> {
  const conn = await connectionFor(host, capability)
  gate?.(host, command)
  return sendOn(conn, host, command, params, timeoutMs)
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
    if (isServerStopping()) return { kind: 'unreachable', error: new TransferServerStoppingError(host).message }
    const conns = await resolver(host)
    if (conns.length === 0) return { kind: 'unreachable', error: noLink(host).message }
    res = await sendOn(conns[0], host, 'fs.find', { path: '~/.claude/projects', name: sessionId + '.jsonl', maxDepth: TRANSCRIPT_FIND_DEPTH }, READ_RPC_MS)
  } catch (err) {
    // sendOn already words a link this server's stop closed; any other error is the host's.
    if (interruptedByShutdown(err)) return { kind: 'unreachable', error: new TransferServerStoppingError(host).message }
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
  /**
   * Stops the relay before its next chunk. It throws the signal's reason when that is an
   * Error (a bare abort() sets an AbortError, which is one), else a TransferCommandError `aborted`.
   */
  signal?: AbortSignal
  /** How long the final part may take (the receiver hashes and syncs the whole file then); default 60 s. */
  finalPartTimeoutMs?: number
  /**
   * Called synchronously right before each read or write leaves, after its link was found (a
   * redial included), so nothing awaits between it and the send. A throw stops the relay at
   * once with that error, never retried (host-copy.ts: the grant and the host's stop).
   */
  gate?: SendGate
}

export interface RelayResult { bytes: number; sha256: string; chunks: number; retries: number; path?: string }

async function readChunk(host: string, path: string, start: number, length: number, gate?: SendGate): Promise<{ data: string; bytesRead: number; fileSize: number }> {
  const conn = await connectionFor(host, READ_RANGE_CAPABILITY)
  gate?.(host, 'fs.readRange')
  const res = await sendOn(conn, host, 'fs.readRange', { path, start, length }, READ_RPC_MS)
  if (res.ok === false) {
    throw new TransferCommandError(String(res.error ?? 'fs.readRange failed'), host, 'fs.readRange', 'read_failed')
  }
  return { data: String(res.data ?? ''), bytesRead: Number(res.bytesRead ?? 0), fileSize: Number(res.fileSize ?? -1) }
}

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
  // Each part is one upload frame onto the target: at most what the paced bulk link carries in time.
  const chunk = Math.max(1, Math.min(opts.chunkBytes ?? MAX_UPLOAD_FRAME_BYTES, MAX_CHUNK_BYTES, MAX_UPLOAD_FRAME_BYTES))
  const hasher = opts.sha256 ? null : crypto.createHash('sha256')
  let hashedTo = 0
  let deliveredTo = 0
  // The caller's gate refusing is final: kept here so the retry below never takes it for a lost link.
  let stopped: { err: unknown } | null = null
  const gate: SendGate | undefined = opts.gate && ((host, command) => {
    try { opts.gate!(host, command) } catch (err) { stopped = { err }; throw err }
  })
  // Both ends are checked up front, so a missing capability fails before any byte moves.
  await connectionFor(toHost, opts.privateAttempt !== undefined ? PRIVATE_STAGE_CAPABILITY : WRITE_PART_CAPABILITY)
  await connectionFor(fromHost, READ_RANGE_CAPABILITY)
  let offset = 0
  let chunks = 0
  // What a failed chunk means (part-retry.ts): inside a link wait (a task move), a dropped link is waited out.
  const retry = partRetry({ host: toHost, path: toPath, size: chunk, tries: opts.retries ?? 3, delayMs: opts.retryDelayMs ?? 500 })
  for (;;) {
    // Outside the try: a stop is final, never a chunk to retry.
    if (opts.signal?.aborted) {
      const reason: unknown = opts.signal.reason
      throw reason instanceof Error ? reason : new TransferCommandError('the relay was stopped', fromHost, 'relay', 'aborted')
    }
    try {
      let bytes = Buffer.alloc(0)
      // An empty file is read once too, so a source that is not empty after all is caught.
      if (total === null || total - offset > 0 || offset === 0) {
        const left = total === null ? 0 : total - offset
        const got = await readChunk(fromHost, fromPath, offset, left > 0 ? Math.min(retry.size, left) : retry.size, gate)
        if (!(got.fileSize >= 0)) throw new TransferCommandError(`${fromPath}: no file size in the read reply`, fromHost, 'fs.readRange', 'read_failed')
        if (total === null) total = got.fileSize
        if (got.fileSize !== total) throw new TransferCommandError(`${fromPath} is ${got.fileSize} bytes now, expected ${total}`, fromHost, 'fs.readRange', 'source_changed')
        const want = Math.min(retry.size, total - offset)
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
        ...(final && opts.finalPartTimeoutMs !== undefined ? { timeoutMs: opts.finalPartTimeoutMs } : {}),
      }, gate)
      chunks++
      retry.ok()
      if (hasher && fresh && !final) { hasher.update(fresh); hashedTo = offset + bytes.length }
      if (opts.onBytes && offset + bytes.length > deliveredTo) {
        opts.onBytes(bytes.subarray(deliveredTo - offset))
        deliveredTo = offset + bytes.length
      }
      offset += bytes.length
      opts.onProgress?.({ sent: offset, total })
      if (final) return { bytes: reply.staged, sha256: reply.sha256 ?? sha256 ?? '', chunks, retries: retry.retries, ...(reply.path ? { path: reply.path } : {}) }
    } catch (err) {
      if (stopped) throw (stopped as { err: unknown }).err
      offset = await retry.next(err, offset)
    }
  }
}

/** caller-proof-v1: whether process `pid` of `host` runs inside session `sid` there, by that host's daemon (approvals). */
export async function callerCheck(host: string, opts: { sid: string; pid: number; at: number }): Promise<import('../../providers/gateway-core.js').CallerProof> {
  const { CALLER_PROOF_CAPABILITY } = await import('../../providers/gateway-core.js')
  const reply = await call<{ proof?: import('../../providers/gateway-core.js').CallerProof }>(host, CALLER_PROOF_CAPABILITY, 'caller.check', { ...opts }, 4_000)
  if (!reply.proof || typeof reply.proof.verified !== 'boolean') throw new Error('caller.check: no proof in the answer')
  return reply.proof
}
