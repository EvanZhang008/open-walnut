/**
 * `host_copy`: a task's session copies ONE file between two hosts Walnut knows
 * (2026-11-03: tasks built the iOS app on a Mac with host_exec, but could not send
 * the sources there or bring the results back). The bytes go through this server in
 * chunks (relayFile in transfer/daemon-transfer-client.ts: fs.readRange on the
 * sender, fs.writePart on the receiver, resumed after a gap, size and sha256 checked
 * before the file is renamed into place). This file is the gate and the job; the
 * path rules and probes are host-copy-paths.ts.
 *
 *   - only a task's session asks; each side defaults to the host its session record
 *     names (this Mac when it names none), and the two sides differ;
 *   - every side but the one its record names needs this task's grant there, the one
 *     host_exec uses (exec-grants.ts: asked once by letter, kept until revoked): reading
 *     or writing a file there is as strong as a command. A record with no host has no
 *     grant-free side;
 *   - one regular file of at most 2 GiB, never credentials or Walnut's own data; a
 *     folder is refused (tar it first), a file over the cap before a byte moves;
 *   - on a Mac, a place macOS guards (Downloads, Documents, Mail, /Volumes, ...) is
 *     refused unless the caller passes allow_prompts: touching it puts a permission
 *     dialog on that Mac's screen, and the copy would wait in it (409 may_prompt);
 *   - one copy at a time onto one file of one host (409 target_busy);
 *   - the copy runs here as a job, at most 2 at once per task and 4 on this server,
 *     stopped at its 1-hour deadline, or when a grant it uses is revoked or the user closes a
 *     host it uses, read right before every part it sends either way. The call waits
 *     up to a minute, or what the caller's own deadline leaves (src/lib/answer-by.ts: a
 *     session on another host, whose gateway gives up at 20 s), then answers `running`
 *     with its copyId for host_copy_result. The caller may name the id (`copy_id`, the
 *     walnut CLI picks one, host-exec-run-id.ts): the same id again, or the same copy
 *     while it runs, answers that copy and never starts a second one.
 *
 * A failure leaves the target as it was: the receiver renames only a whole, checked
 * file. The partial `<to>.walnut-part` is removed when the receiver allows it, and the
 * answer names it when it could not be.
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { log } from '../../logging/index.js'
import { HostExecError, budgetLeft, callerOf, grantFor, hostName, type Caller } from './host-exec.js'
import { checkPath, macPlace, macSide, planTarget, probe, refuseMacPlace, refuseProtected, sourceSize, trimSlashes, type MacSide } from './host-copy-paths.js'

export const MAX_COPY_BYTES = 2 * 1024 ** 3
export const MAX_COPIES_PER_TASK = 2
export const MAX_COPIES_RUNNING = 4
const COPY_MAX_MS = 60 * 60_000
/** A copy's answer stays readable this long after it ended. */
const KEEP_ENDED_MS = 30 * 60_000
/** The longest one call waits for its copy: under the 2-minute default of an agent's Bash tool. */
export const HOLD_MAX_MS = 60_000
/** What a call keeps back of its hold to write its answer. */
const REPLY_MARGIN_MS = 1_000
/** Under the 4 MB part limit, and well under the frame size some proxies cut. */
const CHUNK_BYTES = 2 * 1024 * 1024
const CLEANUP_MS = 5_000
/** The final part: the receiver hashes and syncs the whole file before it answers. */
const FINAL_PART_BASE_MS = 60_000
const FINAL_PART_BYTES_PER_S = 25 * 1024 * 1024
const COPY_ID_RE = /^hc-[A-Za-z0-9_-]{4,64}$/
const LOCAL = '__local__'

const DEFAULT_TUNING = { deadlineMs: COPY_MAX_MS, chunkBytes: CHUNK_BYTES }
let tuning = { ...DEFAULT_TUNING }

/** Tests: a short deadline, a frequent grant check, small chunks (null = back to the defaults). */
export function setHostCopyTuningForTest(t: Partial<typeof DEFAULT_TUNING> | null): void {
  tuning = { ...DEFAULT_TUNING, ...(t ?? {}) }
}

export interface CopyParams { from?: unknown; to?: unknown; from_host?: unknown; to_host?: unknown; copy_id?: unknown; allow_prompts?: unknown }

interface CopyJob {
  id: string
  key: string
  taskId: string
  fromHost: string
  toHost: string
  from: string
  /** The path asked for, then the final one once the target was read. */
  to: string
  total: number | null
  sent: number
  /** A part was sent toward the receiver (it may hold a partial file even with nothing acknowledged). */
  wroteAny?: boolean
  startedAt: number
  endedAt?: number
  /** The file this copy holds while it writes it (targets). */
  lockKey?: string
  done: Promise<void>
  answer?: Record<string, unknown>
  failure?: HostExecError
  /** The sides that are Macs, and whether the caller let this copy touch places macOS guards there. */
  macs: { from: MacSide | null; to: MacSide | null }
  allowPrompts: boolean
  /** A side this copy touches in a guarded place (only with allowPrompts): a wait there is a dialog, not a lost host. */
  dialog?: { host: string; path: string }
}

/** Every copy by id; a copy joined under a second id is listed under both. */
const jobs = new Map<string, CopyJob>()
/** The file of a host each running copy writes, `${host}\0${path}`. */
const targets = new Map<string, CopyJob>()

function where(host: string, p: string): string {
  return `${host}:${p}`
}

function running(): CopyJob[] {
  return [...new Set(jobs.values())].filter((j) => !j.endedAt)
}

/** A found ~/.ssh/config row of a machine that joined the host network is that machine (joined-twins.ts). */
async function joinedRow(host: string): Promise<string> {
  if (host === LOCAL) return host
  const [{ getConfig }, { joinedAliasOf }] = await Promise.all([import('../config-manager.js'), import('./joined-twins.js')])
  const config = await getConfig()
  return joinedAliasOf(config.hosts ?? {}, config.net)(host) || host
}

/** One side's host: `def` when not named, else an alias or a `@tag` selector (a named found twin is its joined row). */
async function sideHost(raw: unknown, def: string, own: string | null, which: 'from_host' | 'to_host'): Promise<string> {
  const asked = typeof raw === 'string' ? raw.trim() : ''
  if (!asked) return def
  const { parseHostSelector, pickHost, HostSelectorError } = await import('./host-select.js')
  let host: string
  try {
    const tags = parseHostSelector(asked)
    host = tags ? (await pickHost(tags)).host : asked
  } catch (err) {
    if (err instanceof HostSelectorError) throw new HostExecError(`${which}: ${err.message}`, err.code === 'bad_selector' ? 400 : 409, err.code)
    throw err
  }
  host = await joinedRow(host === 'local' ? LOCAL : host)
  if (host === LOCAL || host === own) return host
  const { getConfig } = await import('../config-manager.js')
  if (!Object.hasOwn((await getConfig()).hosts ?? {}, host)) {
    throw new HostExecError(`Unknown host for ${which}: ${host} (host_list names them)`, 404, 'unknown_host')
  }
  return host
}

/** The caller, and the host its session record names as it is written (null: it names none). */
async function theCaller(sid: string | undefined): Promise<{ caller: Caller; own: string | null }> {
  let caller: Caller
  try {
    caller = await callerOf(sid)
  } catch (err) {
    if (err instanceof HostExecError && err.code === 'session_only') {
      throw new HostExecError('host_copy runs for a task\'s session; a person copies files with their own tools (scp)', 403, 'session_only')
    }
    throw err
  }
  const { resolveCaller } = await import('../sessions/session-send-core.js')
  const c = await resolveCaller(sid)
  const raw = c.kind === 'session' && typeof c.record.host === 'string' ? c.record.host.trim() : ''
  return { caller, own: !raw ? null : raw === 'local' ? LOCAL : raw }
}

/**
 * The grant on each side but the grant-free one. Both are asked before a refusal is
 * thrown, so a copy between two other hosts sends both letters at once.
 */
async function grantsFor(caller: Caller, own: string | null, hosts: string[], preview: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  let waiting: HostExecError | null = null
  const letters: string[] = []
  for (const host of hosts) {
    if (own !== null && host === own) continue
    try {
      out.set(host, await grantFor(caller, host, preview))
    } catch (err) {
      if (!(err instanceof HostExecError) || err.code !== 'exec_grant_required') throw err
      waiting ??= err
      if (typeof err.data.letterId === 'string') letters.push(err.data.letterId)
    }
  }
  if (waiting) {
    if (letters.length > 1) waiting.data = { ...waiting.data, letterIds: letters }
    throw waiting
  }
  return out
}

function sizeText(n: number): string {
  if (n < 1024) return `${n} bytes`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(1)} ${units[i]}`
}

function durationText(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}-hour`
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}-minute`
  return `${Math.max(1, Math.round(ms / 1000))}-second`
}

class CopyStopped extends Error {
  constructor(public why: 'deadline' | 'revoked' | 'closed', public host?: string) {
    super(why)
    this.name = 'CopyStopped'
  }
}

/** A failure that is the link: a dropped socket, a command that timed out. */
const LINK_TROUBLE = /not connected|timed? ?out|closed|ECONNRESET|EPIPE|socket|disconnect|lost/i

/** Every way a copy can fail, in one plain sentence, with the target left as it was. */
export async function copyFailure(err: unknown, job: Pick<CopyJob, 'fromHost' | 'toHost' | 'from' | 'to' | 'sent' | 'total' | 'dialog'>): Promise<HostExecError> {
  if (err instanceof HostExecError) return err
  const [{ DaemonNeedsUpgradeError }, { TransferCommandError, TransferHostOfflineError }] = await Promise.all([
    import('../daemon-file-reader.js'), import('../transfer/daemon-transfer-client.js'),
  ])
  const untouched = `Nothing was written at ${where(job.toHost, job.to)}.`
  const progress = job.total !== null ? ` after ${sizeText(job.sent)} of ${sizeText(job.total)}` : ''
  if (err instanceof CopyStopped) {
    if (err.why === 'deadline') return new HostExecError(`The copy stopped at its ${durationText(tuning.deadlineMs)} deadline${progress}. ${untouched} Copy a smaller file (split it), or ask the user.`, 504, 'copy_deadline')
    if (err.why === 'closed') return new HostExecError(`The user closed ${await hostName(err.host ?? '')} to tasks on other hosts (Settings › Remote Hosts); the copy stopped${progress}. ${untouched}`, 403, 'exec_host_closed')
    return new HostExecError(`The user revoked this task's grant for ${await hostName(err.host ?? '')}; the copy stopped${progress}. ${untouched}`, 403, 'exec_grant_revoked')
  }
  if (err instanceof TransferHostOfflineError) {
    return new HostExecError(`Walnut is not connected to ${await hostName(err.host)} right now. ${untouched} Try again when host_list shows it connected.`, 503, 'host_offline')
  }
  if (err instanceof DaemonNeedsUpgradeError) {
    const what = err.host === job.toHost ? 'receive' : 'send'
    return new HostExecError(`The Walnut daemon on ${await hostName(err.host)} needs an update before it can ${what} files (it updates on its next connect). ${untouched}`, 409, 'daemon_upgrade')
  }
  if (err instanceof TransferCommandError) {
    const msg = err.message.replace(/^fs\.\w+ failed: /, '')
    switch (err.code) {
      case 'checksum_mismatch':
        return new HostExecError(`What ${await hostName(job.toHost)} received does not match what was read from ${where(job.fromHost, job.from)} (sha256). ${untouched} Copy it again.`, 502, 'checksum_mismatch')
      case 'size_mismatch':
        return new HostExecError(`${await hostName(job.toHost)} received a different number of bytes than were sent (${msg}). ${untouched} Copy it again.`, 502, 'size_mismatch')
      case 'source_changed':
        return new HostExecError(`${where(job.fromHost, job.from)} changed size while it was copied (${msg}). ${untouched} Copy it again once it stops changing.`, 409, 'source_changed')
      case 'read_failed':
        return new HostExecError(`${await hostName(job.fromHost)} could not read ${job.from}${progress} (${msg}). ${untouched}`, 502, 'read_failed')
      case 'too_large':
        return new HostExecError(`${await hostName(job.toHost)} refused a part as too large (${msg}). ${untouched}`, 413, 'too_large')
      case 'bad_request':
        return new HostExecError(`${await hostName(err.host)} refused the copy: ${msg}. ${untouched}`, 400, 'bad_request')
      default:
        if (err.command === 'fs.writePart') {
          return new HostExecError(`${await hostName(job.toHost)} could not write ${job.to}${progress} (${msg}). ${untouched}`, 502, 'write_failed')
        }
        return new HostExecError(`The copy failed${progress}: ${msg}. ${untouched}`, 502, 'copy_failed')
    }
  }
  // The relay already retried each chunk. A link that kept failing is the host away; anything else is the copy.
  const msg = err instanceof Error ? err.message : String(err)
  // Not a lost host: on a Mac, a read or write in a place macOS guards waits at its permission dialog.
  if (job.dialog && /timed? ?out/i.test(msg)) {
    const name = await hostName(job.dialog.host)
    return new HostExecError(`${name} did not answer about ${where(job.dialog.host, job.dialog.path)}${progress}: macOS is most likely showing a permission dialog for it on ${name}'s screen. ${untouched} Ask the user to answer it there, then copy again.`, 504, 'prompt_timeout', { prompt: where(job.dialog.host, job.dialog.path) })
  }
  if (LINK_TROUBLE.test(msg)) return new HostExecError(`Walnut lost a host during the copy${progress} (${msg}). ${untouched} Copy it again.`, 503, 'host_offline')
  return new HostExecError(`The copy failed${progress}: ${msg}. ${untouched} Copy it again.`, 502, 'copy_failed')
}

/** Whether this copy may have staged bytes on the receiver: a write was answered, or one may have arrived. */
async function mayHaveStaged(err: unknown, job: CopyJob): Promise<boolean> {
  if (job.sent > 0) return true
  const [{ DaemonNeedsUpgradeError }, { TransferCommandError, TransferHostOfflineError }] = await Promise.all([
    import('../daemon-file-reader.js'), import('../transfer/daemon-transfer-client.js'),
  ])
  // Refused before the first write: a capability check, an offline host, the first read.
  if (err instanceof DaemonNeedsUpgradeError || err instanceof TransferHostOfflineError) return false
  return !(err instanceof TransferCommandError && err.command === 'fs.readRange')
}

/** Best effort: the receiver's partial file goes. 'left' when it may still be there. */
async function dropStaging(job: CopyJob): Promise<'removed' | 'left'> {
  const { hostCommand } = await import('../transfer/daemon-transfer-client.js')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const r = await Promise.race([
      hostCommand(job.toHost, 'fs-mutate-v1', 'fs.rm', { path: `${job.to}.walnut-part` }, CLEANUP_MS),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), CLEANUP_MS) }),
    ])
    // ENOENT: nothing was staged after all.
    return r && (r.ok !== false || /\bENOENT\b/.test(String(r.error ?? ''))) ? 'removed' : 'left'
  } catch {
    return 'left' // an older daemon, the host away
  } finally {
    clearTimeout(timer)
  }
}

/** The copy itself, as a job: read both ends, refuse what it cannot copy, hold the target, relay, record the answer. */
async function runCopy(job: CopyJob, mine: { from: boolean; to: boolean }, grantIds: Map<string, string>): Promise<void> {
  const grants = await import('./exec-grants.js')
  const abort = new AbortController()
  const deadline = setTimeout(() => abort.abort(new CopyStopped('deadline')), tuning.deadlineMs)
  deadline.unref?.()
  // Right before every read or write leaves for either host (the probes that size the source and
  // plan the target too): a revoke or the user closing a host since the grant sends nothing more.
  // The reads are synchronous, so nothing waits between this look and the send.
  const gate = (_host?: string, command?: string) => {
    for (const h of grantIds.keys()) {
      if (grants.isHostClosed(h)) throw new CopyStopped('closed', h)
      if (!grants.findGrant(job.taskId, h)) throw new CopyStopped('revoked', h)
    }
    if (command === 'fs.writePart') job.wroteAny = true
  }
  try {
    const name = path.posix.basename(trimSlashes(job.from))
    const [size, plan] = await Promise.all([
      sourceSize(job.fromHost, job.from, mine.from, gate),
      planTarget(job.toHost, job.to, name, async (p) => {
        // Every place the target side reads, the one inside a folder `to` names included.
        if (!job.allowPrompts) await refuseMacPlace(job.toHost, p, job.macs.to, 'write')
        return (await probe(job.toHost, p, gate)).at
      }),
    ])
    if (size > MAX_COPY_BYTES) {
      throw new HostExecError(`${where(job.fromHost, job.from)} is ${sizeText(size)} (${size} bytes); host_copy copies at most ${MAX_COPY_BYTES} bytes (2 GB). Nothing was copied. Compress it, or split it (split -b 1000m) and copy the parts.`, 413, 'too_large')
    }
    refuseProtected(job.toHost, plan.path)
    if (!job.allowPrompts) await refuseMacPlace(job.toHost, plan.path, job.macs.to, 'write')
    else if (!job.dialog && job.macs.to && macPlace(plan.path, job.macs.to)) job.dialog = { host: job.toHost, path: plan.path }
    const lockKey = `${job.toHost}\u0000${path.posix.normalize(plan.path)}`
    const holder = targets.get(lockKey)
    if (holder && !holder.endedAt) {
      const theirs = holder.taskId === job.taskId ? ` (copy ${holder.id}: host_copy_result waits for it)` : ''
      throw new HostExecError(`Another copy writes ${where(job.toHost, plan.path)} right now${theirs}; wait for it, or copy to another path.`, 409, 'target_busy', { path: plan.path })
    }
    targets.set(lockKey, job)
    job.lockKey = lockKey
    job.to = plan.path
    job.total = size
    const { relayFile } = await import('../transfer/daemon-transfer-client.js')
    // Once more now (the target lock and the imports took time), then before every part.
    gate()
    const r = await relayFile(job.fromHost, job.from, job.toHost, job.to, {
      size, chunkBytes: tuning.chunkBytes, signal: abort.signal, gate,
      finalPartTimeoutMs: FINAL_PART_BASE_MS + Math.ceil(size / FINAL_PART_BYTES_PER_S) * 1000,
      onProgress: (p) => { job.sent = p.sent },
    })
    job.answer = {
      copyId: job.id, running: false, from_host: job.fromHost, to_host: job.toHost, from: job.from, to: job.to,
      bytes: r.bytes, sha256: r.sha256, ms: Date.now() - job.startedAt, chunks: r.chunks, retries: r.retries, replaced: plan.replaced,
    }
    log.session.info('host copy', {
      copyId: job.id, taskId: job.taskId, fromHost: job.fromHost, toHost: job.toHost, from: job.from, to: job.to,
      bytes: r.bytes, ms: job.answer.ms, chunks: r.chunks, retries: r.retries, replaced: plan.replaced,
    })
  } catch (err) {
    const failure = await copyFailure(err, job)
      .catch(() => new HostExecError(`The copy failed: ${err instanceof Error ? err.message : String(err)}`, 502, 'copy_failed'))
    failure.data = { ...failure.data, copyId: job.id }
    if (job.lockKey) {
      // A receiver whose grant is revoked now, or that the user closed, is not touched again, whatever
      // stopped the copy: what a part already sent there may have left is named, not removed. Every
      // write passes the gate first, so a copy that never wrote staged nothing.
      const refused = grantIds.has(job.toHost) && (grants.isHostClosed(job.toHost) || !grants.findGrant(job.taskId, job.toHost))
      const left = !job.wroteAny ? 'removed' as const
        : refused ? 'left' as const
        : await mayHaveStaged(err, job).then((m) => (m ? dropStaging(job) : 'removed' as const), () => 'left' as const)
      if (left === 'left') {
        const partial = `${job.to}.walnut-part`
        const how = mine.to ? 'with your own Bash' : `with host_exec on ${job.toHost}`
        failure.message += ` The partial file ${partial} may still be there; delete it ${how}.`
        failure.data = { ...failure.data, partialLeft: partial }
      }
    }
    job.failure = failure
    log.session.warn('host copy failed', {
      copyId: job.id, taskId: job.taskId, fromHost: job.fromHost, toHost: job.toHost, from: job.from, to: job.to,
      sent: job.sent, code: failure.code, error: failure.message,
    })
  } finally {
    clearTimeout(deadline)
    if (job.lockKey && targets.get(job.lockKey) === job) targets.delete(job.lockKey)
    job.endedAt = Date.now()
  }
}

function sweep(): void {
  const t = Date.now()
  for (const [id, j] of jobs) if (j.endedAt && j.endedAt < t - KEEP_ENDED_MS) jobs.delete(id)
}

/** How long this call may wait: a minute, or what the caller's own deadline leaves. */
function holdFor(caller: Caller, since: number): number {
  return Math.max(0, Math.min(HOLD_MAX_MS, budgetLeft(caller, since) - REPLY_MARGIN_MS))
}

async function waitFor(job: CopyJob, ms: number): Promise<void> {
  if (job.endedAt || ms <= 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([job.done, new Promise<void>((r) => { timer = setTimeout(r, ms) })])
  clearTimeout(timer)
}

/** The copy's answer: its result, its refusal (thrown), or where it stands. */
function answerOf(job: CopyJob, same = false): Record<string, unknown> {
  if (job.failure) throw job.failure
  const mark = same ? { sameCopy: true } : {}
  if (job.answer) return { ...job.answer, ...mark }
  return {
    copyId: job.id, running: true, from_host: job.fromHost, to_host: job.toHost, from: job.from, to: job.to,
    bytes: job.total, sent: job.sent, ms: Date.now() - job.startedAt, ...mark,
  }
}

/** Copy one file between two hosts for the caller's task (see the file comment). */
export async function copyBetweenHosts(params: CopyParams, callerSid: string | undefined): Promise<Record<string, unknown>> {
  const t0 = Date.now()
  const from = checkPath(params.from, 'from')
  const to = checkPath(params.to, 'to')
  const asked = typeof params.copy_id === 'string' && params.copy_id !== '' ? params.copy_id : null
  if (asked !== null && !COPY_ID_RE.test(asked)) throw new HostExecError('copy_id must be hc- and 4 to 64 letters, digits, - or _ (the walnut CLI picks one)', 400, 'bad_request')
  const { caller, own } = await theCaller(callerSid)
  const def = own ?? LOCAL
  const fromHost = await sideHost(params.from_host, def, own, 'from_host')
  const toHost = await sideHost(params.to_host, def, own, 'to_host')
  if (fromHost === toHost) {
    throw new HostExecError(fromHost === def
      ? `Both sides are your own host (${def}): copy it with cp in your own Bash. Name another host in from_host or to_host.`
      : `Both sides are ${fromHost}: copy it there with cp through host_exec.`, 400, 'same_host')
  }
  // Before the grant: a copy it would refuse asks nothing of the user.
  refuseProtected(fromHost, from)
  refuseProtected(toHost, to)
  const allowPrompts = params.allow_prompts === true
  const macs = { from: await macSide(fromHost), to: await macSide(toHost) }
  if (!allowPrompts) {
    await refuseMacPlace(fromHost, from, macs.from, 'read')
    await refuseMacPlace(toHost, to, macs.to, 'write')
  }
  const preview = `host_copy ${where(fromHost, from)} -> ${where(toHost, to)}`
  const grantIds = await grantsFor(caller, own, [fromHost, toHost], preview)
  sweep()
  // The same copy again (an answer lost on the way back): that copy, never a second one.
  const named = asked !== null ? jobs.get(asked) : undefined
  if (named) {
    if (named.taskId !== caller.taskId) throw new HostExecError(`Copy ${asked} is another copy's; leave copy_id out and Walnut picks a new one.`, 409, 'copy_id_taken')
    await waitFor(named, holdFor(caller, t0))
    return answerOf(named, true)
  }
  const key = [caller.taskId, fromHost, from, toHost, to].join('\u0000')
  const same = running().find((j) => j.key === key)
  if (same) {
    if (asked !== null) jobs.set(asked, same)
    await waitFor(same, holdFor(caller, t0))
    return answerOf(same, true)
  }
  const live = running()
  if (live.filter((j) => j.taskId === caller.taskId).length >= MAX_COPIES_PER_TASK) {
    throw new HostExecError(`This task already copies ${MAX_COPIES_PER_TASK} files between hosts; wait for one (host_copy_result).`, 429, 'busy')
  }
  if (live.length >= MAX_COPIES_RUNNING) {
    throw new HostExecError(`Walnut already copies ${MAX_COPIES_RUNNING} files between hosts; try again in a minute.`, 429, 'busy')
  }
  const job: CopyJob = {
    id: asked ?? `hc-${randomUUID()}`, key, taskId: caller.taskId, fromHost, toHost, from, to,
    total: null, sent: 0, startedAt: Date.now(), done: Promise.resolve(), macs, allowPrompts,
  }
  if (allowPrompts) {
    if (macs.from && macPlace(from, macs.from)) job.dialog = { host: fromHost, path: from }
    else if (macs.to && macPlace(to, macs.to)) job.dialog = { host: toHost, path: to }
  }
  jobs.set(job.id, job)
  // `mine` only words the hints (your own Bash or host_exec); the grants are grantIds.
  job.done = runCopy(job, { from: fromHost === def, to: toHost === def }, grantIds)
  void import('./exec-grants.js').then((g) => { for (const id of grantIds.values()) void g.noteRun(id, preview) }).catch(() => {})
  await waitFor(job, holdFor(caller, t0))
  return answerOf(job)
}

/** Wait up to `wait_ms` (default: as long as a call may) for a copy of the caller's task. */
export async function copyResult(params: { copy_id?: unknown; wait_ms?: unknown }, callerSid: string | undefined): Promise<Record<string, unknown>> {
  const t0 = Date.now()
  const { caller } = await theCaller(callerSid)
  sweep()
  const id = typeof params.copy_id === 'string' ? params.copy_id : ''
  const job = jobs.get(id)
  if (!job || job.taskId !== caller.taskId) {
    throw new HostExecError(`No copy ${id || '(no copy_id)'} for this task: it never reached Walnut, or it ended over ${KEEP_ENDED_MS / 60_000} minutes ago, or Walnut restarted since. Look at the target, or copy again.`, 404, 'unknown_copy')
  }
  const wanted = typeof params.wait_ms === 'number' && Number.isFinite(params.wait_ms) && params.wait_ms >= 0 ? params.wait_ms : HOLD_MAX_MS
  await waitFor(job, Math.min(wanted, holdFor(caller, t0)))
  return answerOf(job)
}

/** Tests: forget every copy (the ones running finish on their own). */
export function resetHostCopyForTest(): void {
  jobs.clear()
  targets.clear()
}
