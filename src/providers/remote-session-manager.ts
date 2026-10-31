/**
 * RemoteSessionManager — SessionManager implementation for remote sessions via daemon.
 *
 * Delegates all operations to a DaemonConnection (WebSocket → remote daemon).
 * The daemon manages the Claude CLI process on the remote machine.
 *
 * KEY DIFFERENCES from a hypothetical local-only manager:
 * - No local JSONL file — daemon streams events via WebSocket, we track lastEventAt in memory
 * - No local FIFO — daemon writes to remote FIFO
 * - No PID monitoring — daemon sends exit events
 * - Image paths are rewritten (local → remote on send, remote → local on receive)
 *
 * ARCHITECTURE:
 *   Walnut → RemoteSessionManager → DaemonConnection → WebSocket → SSH tunnel → daemon
 *   daemon → Claude CLI (FIFO + JSONL monitoring) → WebSocket → Walnut
 */

import fs from 'node:fs'
import path from 'node:path'
import { IS_EPHEMERAL, REMOTE_IMAGES_DIR, WALNUT_HOME } from '../constants.js'
import { cliStateOf, isConversationActivityLine, type CliTurnState } from './stream-activity.js'
import {
  writeMirrorSidecar, backfillMirrorSidecar, resolveSessionMirrorPath, looksAlreadyMirrored,
  fetchRecentlyMissing, noteFetchMissing, noteFetchFound, isNotFoundReply, startMirrorDownload,
} from '../core/remote-image-mirror.js'
import { log } from '../logging/index.js'
import { getDaemonConnection, getDirectDaemonConnection, DaemonConnection, type DaemonEvent, type DaemonTaskState, type DaemonGetStateResult } from './daemon-connection.js'
import { BudgetCheckingError, BudgetPausedError, heldByAnotherProcess, holderKindOf, holderPidOf, isDaemonCommandOutcomeUnknown, sendMayHaveLanded, SendHeldError, SendOutcomeUnknownError, SessionHeldElsewhereError } from './delivery-failure.js'
import { InheritedSessionRefusedError } from './ephemeral-session-gate.js'
import { linkFailureKind } from './link-failure.js'
import { CloudSessionLink } from './cloud-session-link.js'
import { isSessionStopSuperseded, SessionStopSupersededError } from '../core/sessions/session-stop.js'
import { describeStopRefusal, STOP_NOT_SENT_NO_OWNERSHIP_CHECK, stopProvenance } from '../core/sessions/stop-provenance.js'
import {
  findImagePaths,
  findLocalImagePaths,
  findRemoteImagePaths,
  findRelativeImageNames,
} from './session-io.js'
import type { SshTarget } from './session-io.js'
import { spawnGateSentence } from '../core/hosts/host-readiness.js'
import type {
  LineWriteOptions,
  SessionManager,
  TransportStartOptions,
  TransportStartResult,
  TransportAttachOptions,
  TransportAttachResult,
} from './session-manager.js'

// DUP-DEBUG: per-process counter so each RemoteSessionManager has a stable id
// in logs. If logs show two different `rsmId`s touching the same sid for the
// same line, we have leaked instances; if the same rsmId logs the same uuid
// twice, the duplication is upstream of walnut.
let __rsmIdCounter = 0

/** The stand-in path a daemon session's outputFile carries: its stream lives on the host. */
export function remoteOutputSentinel(hostKey: string, sid: string): string {
  return `remote://${hostKey}/${sid}`
}

/** A `send` carrying `dedupe` writes nothing when the daemon can tell what became of the line. */
const SEND_DEDUPE_CAPABILITY = 'send-dedupe-v1'
/** A dedupe `send` carrying `lostPid` writes the line again into the process that read past it. */
const SEND_LOST_LINE_CAPABILITY = 'send-lost-line-v1'
/** A `send` or `start` carrying `bootWait` waits through the boot of the CLI it starts. */
const SEND_BOOT_WAIT_CAPABILITY = 'send-boot-wait-v1'

export class RemoteSessionManager implements SessionManager {
  /**
   * How long a send whose answer never came keeps asking the daemon (tests
   * shorten it). A reachable daemon answers the first ask within a second; this
   * bounds a host whose answers are stuck, while lines behind it wait (visibly).
   */
  static SEND_CONFIRM_DEADLINE_MS = 60_000
  /** One ask's own timeout: shorter than a send's, so a stuck answer is asked again soon. */
  static SEND_CONFIRM_ATTEMPT_MS = 10_000
  /** The answer to a boot-wait line: past the daemon's 120s boot deadline (FIFO_BOOT_WRITE_DEADLINE_MS). */
  static BOOT_WAIT_SEND_TIMEOUT_MS = 150_000

  private readonly _rsmId: number = ++__rsmIdCounter
  private conn: DaemonConnection | null = null
  private sshTarget: SshTarget | null
  private hostKey: string
  private _pid: number | null = null
  private _remoteOutputFile: string | null = null
  private _hasPipe = false
  // Byte cursor into the daemon's STREAM file (~/.open-walnut/tmp/streams/<sid>.jsonl).
  // Only an ABSOLUTE position is a valid fromOffset for daemon attach. It is
  // absolute only after start()/attach() adopted the daemon-reported offset —
  // _cursorValid tracks that. A fresh RSM (e.g. created by attachToExisting
  // after a walnut restart) has _fileSize=0 which is NOT "replay everything",
  // it's "I have no cursor": sending it as fromOffset replayed multi-MB of
  // history into the UI (the "whole conversation replays" bug, path #4).
  private _fileSize = 0
  private _cursorValid = false
  // L1 versioned events: highest event version (byte offset `v`) already delivered
  // downstream. The daemon stamps each jsonl event with `v` (monotonic per session,
  // identical live vs replay), so `v <= _lastSeenV` is a deterministic skip — covering
  // duplicates AND out-of-order replay in one comparison. Old daemons send no `v`; for
  // those we fall back to the uuid Set below. -1 = nothing seen yet.
  private _lastSeenV = -1
  private _imageCache = new Map<string, string>()
  /**
   * The exact text of the last outbound user message AFTER prepareOutbound()
   * (remote sessions: local image paths uploaded + rewritten to remote paths).
   * This is what the CLI actually echoes into the canonical JSONL, so echo
   * claims must be registered with THIS text, not the pre-rewrite queue text
   * (inc-1787704938224: every image message's claim held local paths, never
   * bound, and the optimistic bubble pinned at the bottom until remount).
   */
  private _lastPreparedOutbound: string | undefined
  private unsubscribeEvent: (() => void) | null = null
  private _onOutput: ((event: { line: string; v?: number }) => void) | null = null
  private _onExit: ((code: number, stderr?: string) => void) | null = null
  private _sid: string | null = null
  /**
   * Old sid kept during the async rename transition. Events may still arrive
   * from the daemon tagged with the old sid while it processes the rename command.
   * Cleared once the daemon confirms the rename is complete.
   */
  private _prevSid: string | null = null
  private _lastEventAt = 0
  // What the CLI last said about its turn (session_state_changed), and when this
  // manager took the process on: the idle reaper reads both (session-health-monitor.ts).
  private _cliState: CliTurnState | null = null
  private _attachedAt = 0
  // UUIDs of JSONL events already delivered to downstream. Used to dedup
  // events arriving via two paths — the daemon's realtime push, or any
  // future catch-up / resync mechanism (daemon's attach replay, full
  // periodic pull). Claude Code assigns each message a uuid in its JSONL
  // output; collisions across different sources are intentional (same
  // logical event). No uuid (e.g. `system.init` synthesized by daemon or
  // walnut) means always deliver.
  // Bounded FIFO (insertion-ordered Set): dedup only needs to cover replay /
  // catch-up bursts that arrive close together, NOT a session's entire
  // multi-hour history. An unbounded Set here was a dominant driver of RSS
  // growth (a 10h session sees tens of thousands of uuids). Cap at the last
  // SEEN_UUID_CAP; when full, evict the oldest (Set preserves insertion order).
  private _seenUuids: Set<string> = new Set()
  private static readonly SEEN_UUID_CAP = 5000

  get isRemote(): boolean { return this.hostKey !== '__local__' }
  readonly processName = 'daemon'

  private _directWsUrl: string | undefined
  private cloudLink: CloudSessionLink | null = null
  private cloudGeneration = 0
  private cloudPendingRequest: { id: string; toolName: string } | null = null
  /** A rewrite whose cloud acknowledgement may be lost is confirmed without rewriting again. */
  private cloudRewriteAttempts = new Map<string, { pid: number; generation: number }>()
  private knownPermissionRequests = new Map<string, string>()

  private rememberPermission(requestId: string, toolName: string): void {
    this.knownPermissionRequests.delete(requestId)
    this.knownPermissionRequests.set(requestId, toolName)
    if (this.knownPermissionRequests.size > 64) this.knownPermissionRequests.delete(this.knownPermissionRequests.keys().next().value!)
  }

  private rewriteAlreadyAttempted(sid: string, opts: LineWriteOptions | undefined): boolean {
    const held = this.cloudRewriteAttempts.get(`${sid}\n${opts?.uuid}`)
    return held?.pid === opts?.lostPid && held?.generation === (opts?.lostGeneration ?? 0)
  }
  private cloudAlive: boolean | null = null
  private cloudEventAt = 0

  private closeCloudLink(): void {
    this.cloudGeneration++
    this.cloudLink?.close()
    this.cloudLink = null
    this.cloudPendingRequest = null
    this.cloudAlive = null
    this.cloudEventAt = 0
  }

  private noteCloudAttachment(reply: Record<string, unknown>): void {
    if (reply.ok !== true || typeof reply.alive !== 'boolean') return
    this.cloudAlive = reply.alive
    this.cloudEventAt = Date.now()
    if (reply.alive) {
      if (typeof reply.pid === 'number') this._pid = reply.pid
      this._hasPipe = true
      // Catch-up can run before the attach reply: never rewind its cursor.
      if (typeof reply.currentOffset === 'number' && reply.currentOffset > this._fileSize) this.adoptCursor(reply.currentOffset)
    }
    // A cloud attachment that found no live process does not authorize a
    // native stop or cold resume. The queued line waits for native recovery.
    const pending = reply.pendingCtrl as { reqId?: unknown; toolName?: unknown; request?: unknown } | null
    if (reply.alive && typeof pending?.reqId === 'string' && pending.request && typeof pending.request === 'object'
      && this.cloudPendingRequest?.id !== pending.reqId) {
      this.cloudPendingRequest = { id: pending.reqId, toolName: String(pending.toolName ?? '') }
      this.rememberPermission(pending.reqId, String(pending.toolName ?? ''))
      this._onOutput?.({ line: JSON.stringify({ type: 'control_request', request_id: pending.reqId, request: pending.request }) })
    }
  }

  private async ensureCloudLink(sid: string): Promise<void> {
    let link = this.cloudLink
    if (!link) {
      const generation = this.cloudGeneration
      link = new CloudSessionLink(this.hostKey, sid, () => this.attachFromOffset(), (event) => {
        if (generation !== this.cloudGeneration || this._sid !== sid || this.cloudLink !== link) return
        if (this.conn?.connected) { this.closeCloudLink(); return }
        this.cloudEventAt = Date.now()
        if (event.ev === 'attached') this.noteCloudAttachment(event)
        else {
          if (event.ev === 'exit' || (event.ev === 'session_state' && event.state === 'dead')) this.cloudAlive = false
          else if (event.ev === 'jsonl' || (event.ev === 'session_state' && event.state === 'running')) this.cloudAlive = true
          this.handleDaemonEvent(event)
        }
      })
      this.cloudLink = link
    }
    const generation = this.cloudGeneration
    const reply = await link.connect()
    if (generation !== this.cloudGeneration || this.cloudLink !== link || this._sid !== sid) {
      throw new SendHeldError('Not sent yet: the cloud session connection was cancelled')
    }
    if (reply.ok !== true || reply.alive !== true) {
      throw new SendHeldError('Not sent yet: the cloud session host did not confirm a live process')
    }
    // The attached event applied this reply once. A cached connect result must
    // never restore an already answered permission or rewind newer events.
  }

  constructor(
    private tmpId: string,
    hostKey: string,
    sshTarget: SshTarget | null,
    directWsUrl?: string,
    /** What the daemon runs as the CLI: `claude`, except a test's stand-in (session-manager.ts). */
    private readonly cliCommand = 'claude',
  ) {
    this.hostKey = hostKey
    this.sshTarget = sshTarget
    this._directWsUrl = directWsUrl
  }

  // ── Properties ──

  get pid(): number | null { return this._pid }
  /** start()/attach() bind the sid; before that isAlive() knows nothing. */
  get bound(): boolean { return this._sid !== null }
  /**
   * Remote sessions have no local output file: once start()/attach() bound a sid
   * this is the `remote://<host>/<sid>` sentinel start() returns, and it follows
   * renameForSession(). Null only before a sid is bound. It was a hardcoded null,
   * so the session's re-read after the init rename wiped the sentinel that
   * readSessionHistory, the changes view and the reconciler key on.
   */
  get outputFile(): string | null { return this._sid ? remoteOutputSentinel(this.hostKey, this._sid) : null }
  get hasPipe(): boolean { return this._hasPipe }
  /** See _lastPreparedOutbound — the echo-claim text source for delivery points. */
  get lastPreparedOutbound(): string | undefined { return this._lastPreparedOutbound }
  get tailOffset(): number { return this._fileSize }
  get fileSize(): number { return this._fileSize }
  /** SessionManager contract: null for a local session (its hostKey is '__local__'). */
  get host(): string | null { return this.isRemote ? this.hostKey : null }
  get imageCache(): Map<string, string> { return this._imageCache }
  get lastEventAt(): number { return this._lastEventAt }
  get cliState(): CliTurnState | null { return this._cliState }
  get attachedAt(): number { return this._attachedAt }

  // ── Connection ──

  /**
   * Establish connection to the daemon. Uses direct WebSocket for local daemon
   * or test mode, SSH tunnel for remote production hosts.
   */
  private async ensureConnected(): Promise<DaemonConnection> {
    if (this._directWsUrl) {
      // __local__ goes through the pool: ONE shared connection per wsUrl. A
      // private `new DaemonConnection` here leaked one never-destroyed instance
      // (with ping + permanent reconnect loop) per local session — the
      // 100-instance reconnect storm. Non-__local__ direct URLs (tests with
      // per-test MockDaemons, whose OS-assigned ports get REUSED across tests
      // and would collide in a wsUrl-keyed pool) keep the private connection.
      // WALNUT_LOCAL_CONN_POOL=0 restores the old behavior for __local__ too.
      if (this.hostKey === '__local__' && process.env.WALNUT_LOCAL_CONN_POOL !== '0') {
        this.conn = await getDirectDaemonConnection(this.hostKey, this._directWsUrl)
      } else {
        this.conn = new DaemonConnection(this.hostKey, this.sshTarget)
        await this.conn.connectDirect(this._directWsUrl)
      }
    } else if (this.sshTarget) {
      this.conn = await getDaemonConnection(this.hostKey, this.sshTarget)
    } else {
      throw new Error(`RemoteSessionManager: no directWsUrl and no sshTarget for host "${this.hostKey}"`)
    }
    return this.conn
  }

  /**
   * fromOffset to send on daemon attach. A valid absolute cursor resumes the
   * exact gap; without one, MAX_SAFE_INTEGER subscribes future-only (the
   * daemon's `start < currentOffset` replay check fails) — history is served
   * by the history API, never by stream replay.
   */
  private attachFromOffset(): number {
    return this._cursorValid ? this._fileSize : Number.MAX_SAFE_INTEGER
  }

  /** Adopt the daemon's authoritative absolute stream offset as our cursor. Keeps the L1
   *  version watermark in lockstep: after adopting offset X, any replayed/live line the daemon
   *  sends next has `v > X` (its byte range starts at X), so seeding `_lastSeenV = X` skips
   *  nothing legitimate while still dropping a stale event whose `v <= X`. Single choke point
   *  so _fileSize / _cursorValid / _lastSeenV can never drift apart across start/attach/reconnect. */
  private adoptCursor(offset: number): void {
    this._fileSize = offset
    this._cursorValid = true
    if (offset > this._lastSeenV) this._lastSeenV = offset
  }

  private async dispatch<T>(sid: string, fence: string | null | undefined, send: () => Promise<T>): Promise<T> {
    if (fence === undefined) return send()
    const { sessionStops } = await import('../core/sessions/session-stop.js')
    return sessionStops.dispatch(sid, fence, send)
  }

  // ── Startup ──

  async start(opts: TransportStartOptions): Promise<TransportStartResult> {
    await this.ensureConnected()
    // A process starting (a cold resume included) is activity: its first line
    // can take a while under load, and an empty clock would be read from the
    // transcript of the turn before.
    this._cliState = null
    this._attachedAt = this._lastEventAt = Date.now()

    // Subscribe to daemon events (rebind cleans up any prior listener).
    this._onOutput = opts.onOutput
    this._onExit = opts.onExit
    this._sid = this.tmpId
    this.rebindEventListener()

    // Quick Start spill file: upload to the same absolute path on the remote host
    // before the session starts. The message already references this path as a
    // pointer prompt, so no rewrite is needed. Failure here is fatal — the session
    // would otherwise launch with Claude unable to Read the referenced context.
    // Skip for local daemon — same filesystem, file already exists at that path.
    if (opts.spillFile && this.isRemote) {
      await this.uploadSpillFile(opts.spillFile.localPath)
    }

    // Upload local images to remote host and rewrite paths before sending
    const sendAfterStart = Boolean(opts.markers?.length && this.conn!.hasCapability('send-markers-v1'))
    const preparedMessage = sendAfterStart ? '' : await this.prepareOutbound(opts.message)
    this._lastPreparedOutbound = preparedMessage
    // The start's own first line waits through the CLI's boot (send-boot-wait-v1).
    const startBootWait = !!preparedMessage && this.conn!.hasCapability(SEND_BOOT_WAIT_CAPABILITY)
    const startPayload = {
      sid: this.tmpId,
      ...(this.conn!.hasCapability('cron-supervision-v1') ? { stopFence: opts.stopFence ?? null } : {}),
      args: [this.cliCommand, ...opts.args],
      cwd: opts.cwd,
      message: preparedMessage,
      ...(sendAfterStart ? { deferMessage: true } : {}),
      ...(startBootWait ? { bootWait: true } : {}),
      resume: opts.resume ?? false,
      mode: opts.mode,
      // Pre-assigned user-line uuid for the INITIAL message (cold --resume with a
      // queued batch). Spread so an absent uuid leaves the payload byte-identical
      // to what every older daemon has always received.
      ...(opts.uuid ? { uuid: opts.uuid } : {}),
      // Which Walnut asked, for which task: recorded in the host's spawn journal
      // (daemon-standalone.ts). Older daemons ignore the key.
      origin: { home: WALNUT_HOME, ...(opts.taskId ? { task: opts.taskId } : {}) },
      // A test server runs on a copy of the real data: it may only resume a
      // session it started itself (strictStartRefusal in both daemon twins).
      ...(IS_EPHEMERAL ? { strict: true } : {}),
    }

    let result: Record<string, unknown>
    try {
      result = await this.dispatch(this.tmpId, opts.stopFence, () => startBootWait
        ? this.conn!.send('start', startPayload, RemoteSessionManager.BOOT_WAIT_SEND_TIMEOUT_MS)
        : this.conn!.send('start', startPayload))
    } catch (err) {
      // Stale/dead connection — reconnect and retry with idempotent probe
      if (isDaemonConnError(err)) {
        log.session.warn('RemoteSessionManager: start failed, reconnecting', {
          host: this.hostKey, sid: this.tmpId,
          error: err instanceof Error ? err.message : String(err),
        })
        result = await this.retryStartAfterReconnect(startPayload, opts.stopFence)
      } else {
        throw err
      }
    }

    if (!result.ok) {
      if (result.reason === 'budget_paused' || result.errorKind === 'budget_paused') throw new BudgetPausedError()
      if (result.reason === 'budget_checking' || result.errorKind === 'budget_checking') throw new BudgetCheckingError()
      if (result.reason === 'session_stopped') throw new SessionStopSupersededError('Session start was superseded by a stop request')
      // Another process runs this session on the host (cli-owner-core.ts): typed,
      // so the queue parks the message with that cause instead of retrying it.
      // Not when the holder is this host's own daemon (Walnut's own CLI, which
      // the server lost track of) or a start in progress elsewhere (a claim held
      // for seconds): those pass, and stay the plain retryable failure they were.
      if (result.errorKind === 'session_other_walnut' || result.reason === 'session_other_walnut') {
        throw new SessionHeldElsewhereError(this.hostKey, 'session_other_walnut')
      }
      if ((result.errorKind === 'session_live' || result.reason === 'session_live') && heldByAnotherProcess(result.error)) {
        throw new SessionHeldElsewhereError(this.hostKey, 'session_live', holderPidOf(result.error), holderKindOf(result.error))
      }
      // The daemon's spawn gate already wrote the sentence the user needs (claude
      // not installed / npm build without node, with the install command): pass
      // it through verbatim instead of burying it in a "start failed" wrapper.
      if (result.errorKind === 'claude_missing' || result.errorKind === 'claude_needs_node') {
        // By code, not the daemon's text: an older daemon words it differently,
        // and every surface must read the same sentence as Settings and the banner.
        throw new Error(await spawnGateSentence(result.errorKind, this.isRemote ? this.hostKey : null))
      }
      throw new Error(`Daemon start failed on host "${this.hostKey}": ${result.error}`)
    }

    // Detect spawn failures: daemon returns ok but pid is missing when
    // posix_spawn fails (e.g. cwd doesn't exist on remote host).
    if (!result.pid) {
      throw new Error(`Daemon spawn failed on host "${this.hostKey}": no PID returned (cwd: "${opts.cwd}"). The working directory may not exist on the remote host.`)
    }

    this._pid = (result.pid as number) ?? null
    this._remoteOutputFile = result.outputFile as string ?? null
    this._hasPipe = true

    // Capture initial file size (for resume offset tracking). The daemon's
    // cmdStart reply `offset` is the absolute stream-file position at spawn
    // (0 for fresh, statSync size for resume) — a valid cursor.
    const fileSize = (result.offset as number) ?? 0
    this.adoptCursor(fileSize)

    // The deferred first line has a send's contract (r5 gate N1). It asks first
    // (dedupe): the start may have adopted a live process that holds an earlier,
    // unfinished write of this line, and the daemon then ends that piece before
    // the copy instead of gluing the two. And its answer reaches the caller: a cut
    // (the CLI may exit on the piece without running the line) or a fate the
    // daemon already knew (nothing written) is not a plain delivery.
    let cut = false
    let fate: { fate: string; state?: string } | undefined
    if (sendAfterStart) {
      // bootWait: a CLI resuming a huge transcript reads stdin only after 20s or more
      // (2026-10-30, 136MB: killed twice mid-boot by the plain write deadline).
      const written = await this.writeMessage(opts.message, {
        uuid: opts.uuid, markers: opts.markers, stopFence: opts.stopFence, dedupe: true, bootWait: true,
        onCut: () => { cut = true },
        onFate: (f) => { fate = f },
      })
      if (!written) throw new Error('Session started, but the queued message was not delivered')
    } else {
      for (const marker of opts.markers ?? []) this.writeSyntheticUserEvent(marker.message, marker.messageId)
    }

    log.session.info('RemoteSessionManager: session started', {
      // DUP-DEBUG
      rsmId: this._rsmId,
      host: this.hostKey,
      sid: this.tmpId,
      pid: this._pid,
      resume: opts.resume,
    })

    return {
      pid: this._pid!,
      // Remote sessions use a sentinel path — not a real local file.
      // Callers should check isRemote before attempting file I/O.
      outputFile: remoteOutputSentinel(this.hostKey, this._sid!),
      fileSize,
      ...(cut ? { cut: true } : {}),
      ...(fate ? { fate } : {}),
    }
  }

  /**
   * Reconnect and retry start with idempotent probe — checks if daemon already
   * started the session (response lost on stale connection) before re-spawning.
   */
  private async retryStartAfterReconnect(
    startPayload: Record<string, unknown>,
    stopFence?: string | null,
  ): Promise<Record<string, unknown>> {
    // Clear local reference — do NOT disconnect() the shared pool connection.
    // disconnect() sets _destroyed=true which permanently kills auto-reconnect.
    // The pool's getDaemonConnection() will reconnect if needed.
    this.conn = null
    await this.ensureConnected()

    // Re-subscribe event listener on the fresh connection
    this.rebindEventListener()

    // Idempotent probe: check if daemon already started this sid
    const sid = startPayload.sid as string
    try {
      const status = await this.conn!.send('status', { sid })
      if (status.ok && status.exists && status.alive) {
        log.session.info('RemoteSessionManager: session already alive after reconnect, attaching', {
          host: this.hostKey, sid, pid: status.pid,
        })
        // Session was started by the lost command — attach instead of re-starting.
        // Use the tracked absolute cursor so we skip already-processed bytes and
        // avoid replaying the entire JSONL (duplicate content blocks in UI).
        // No valid cursor → subscribe future-only; we adopt the daemon's
        // currentOffset from the attach reply below.
        const attachResult = await this.conn!.send('attach', { sid, fromOffset: this.attachFromOffset() })
        // Dead session → no watcher → currentOffset 0 is meaningless; skip.
        if (attachResult.alive && typeof attachResult.currentOffset === 'number') {
          this.adoptCursor(attachResult.currentOffset)
        }
        // Merge pid from status into attach result for consistent return shape
        return { ...attachResult, pid: status.pid, outputFile: status.outputFile, offset: this._fileSize }
      }
    } catch {
      // Status probe failed — daemon may not know this session, safe to retry start
    }

    // Session doesn't exist on daemon — safe to retry start
    log.session.info('RemoteSessionManager: retrying start after reconnect', {
      host: this.hostKey, sid,
    })
    // A boot-wait start answers only once the CLI took its line (send-boot-wait-v1).
    return this.dispatch(sid, stopFence, () => startPayload.bootWait === true
      ? this.conn!.send('start', startPayload, RemoteSessionManager.BOOT_WAIT_SEND_TIMEOUT_MS)
      : this.conn!.send('start', startPayload))
  }

  // ── Attach ──

  async attach(opts: TransportAttachOptions): Promise<TransportAttachResult> {
    this.closeCloudLink()
    if (this._sid !== opts.sessionId) this.knownPermissionRequests.clear()
    await this.ensureConnected()

    this._onOutput = opts.onOutput
    this._onExit = opts.onExit
    this._sid = opts.sessionId
    this._cliState = null
    this._attachedAt = Date.now()
    this.rebindEventListener()

    const attachPayload = {
      sid: opts.sessionId,
      // No explicit offset from the caller → use our cursor (future-only when
      // invalid). Defaulting to 0 here means "replay the whole stream file".
      fromOffset: opts.fromOffset ?? this.attachFromOffset(),
      mode: opts.mode,
    }

    let result: Record<string, unknown>
    try {
      result = await this.conn!.send('attach', attachPayload)
    } catch (err) {
      // Stale/dead connection — reconnect and retry (attach is idempotent)
      if (isDaemonConnError(err)) {
        log.session.warn('RemoteSessionManager: attach failed, reconnecting', {
          host: this.hostKey, sid: opts.sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
        // Clear local reference — do NOT disconnect() the shared pool connection.
        // disconnect() sets _destroyed=true which permanently kills auto-reconnect.
        // The pool's getDaemonConnection() will reconnect if needed.
        this.conn = null
        await this.ensureConnected()
        this.rebindEventListener()
        result = await this.conn!.send('attach', attachPayload)
      } else {
        throw err
      }
    }

    if (!result.ok) {
      throw new Error(`Daemon attach failed on host "${this.hostKey}": ${result.error}`)
    }

    this._pid = (result.pid as number) ?? null
    const alive = (result.alive as boolean) ?? false

    // hasPipe must track daemon-authoritative liveness, NOT spawn-vs-attach.
    // Only start() ever set _hasPipe=true; an attach()ed session (walnut
    // restarted under a live CLI — the normal dev:prod redeploy path) kept
    // hasPipe=false forever. Downstream, the turn-end result handler keys
    // "FIFO alive between turns" off hasPipe (claude-code-session.ts): false
    // misclassified every healthy idle FIFO session as EXITING → status
    // 'stopped' → server wiped the stream buffer instantly at each turn end
    // (no cross-turn retention), wrong badge, NEED_ACTION churn, and the
    // 60s activeProcessing force-clear noise. Same class as Bug D
    // (injectMidTurn stale hasPipe) — this is its turn-end sibling.
    // Incident: inc-1783357192826 ("chat vanishes when the turn completes").
    this._hasPipe = alive

    // Adopt the daemon's ABSOLUTE stream-file cursor. _fileSize previously
    // started at 0 on every fresh RSM and only grew via `+=` on received
    // events — a RELATIVE count. Any later attach that sent it as fromOffset
    // (reattachWatcher, retryStartAfterReconnect) made the daemon replay
    // [0..currentOffset) — the "whole conversation replays in UI" bug after a
    // walnut restart. The attach reply's currentOffset is the watcher's
    // absolute position; assign it so all subsequent `+=` stays absolute.
    // (Replayed catch-up bytes arrive BEFORE this reply on the same ws, so
    // assignment here also corrects any double-count from the replay itself.)
    // Dead session → no watcher → currentOffset 0 is meaningless; skip.
    if (alive && typeof result.currentOffset === 'number') {
      this.adoptCursor(result.currentOffset)
    }

    log.session.info('RemoteSessionManager: attached to session', {
      // DUP-DEBUG: rsmId helps pair attach calls with the RSM instance that
      // later emits jsonl/stderr_tail logs.
      rsmId: this._rsmId,
      host: this.hostKey,
      sid: opts.sessionId,
      pid: this._pid,
      alive,
      streamCursor: this._fileSize,
    })

    const pendingCtrl = result.pendingCtrl as { reqId: string; toolName: string; request: Record<string, unknown>; receivedAt: number } | null | undefined
    if (pendingCtrl) this.rememberPermission(pendingCtrl.reqId, pendingCtrl.toolName)

    return {
      pid: this._pid ?? 0,
      alive,
      outputFile: remoteOutputSentinel(this.hostKey, this._sid!),
      pendingCtrl: pendingCtrl ?? null,
    }
  }

  // ── Re-attach after daemon reconnect ──
  //
  // When the SSH tunnel / daemon WebSocket drops, the daemon's close handler
  // calls stopWatching() for every session this connection was watching (see
  // daemon-source.ts:1438). After reconnect, the daemon has no watcher for
  // this session's JSONL file, so newly-produced events never reach walnut —
  // `_lastEventAt` stops advancing, and SessionHealthMonitor eventually kills
  // the session even though the CLI is still producing output remotely.
  //
  // Call this on every successful reconnect to tell the daemon "I want JSONL
  // events for <sid> again, starting from byte offset X". The daemon's
  // cmdAttach will installStartWatching(ws, sid, offset) → new watcher for
  // the new ws. The onEvent listener is also re-bound to the new connection
  // so JSONL events reach this.handleDaemonEvent() again.
  async reattachWatcher(): Promise<boolean> {
    if (!this._sid || !this._onOutput) return false
    try {
      await this.ensureConnected()
      // Rebind event listener on the (possibly new) DaemonConnection instance.
      this.rebindEventListener()

      // Resume from the last byte walnut has processed — avoids replaying
      // content the UI has already rendered (would cause duplicate blocks).
      // Without a valid cursor (fresh RSM after walnut restart), subscribe
      // future-only — sending 0 here replayed the entire multi-MB stream file
      // into the UI ("whole conversation replays" bug, path #4).
      const fromOffset = this.attachFromOffset()
      const result = await this.conn!.send('attach', {
        sid: this._sid,
        fromOffset,
      })
      if (result.ok) {
        // Dead session → no watcher → currentOffset 0 is meaningless; skip.
        if (result.alive && typeof result.currentOffset === 'number') {
          this.adoptCursor(result.currentOffset)
        }
        log.session.info('RemoteSessionManager: reattached watcher after reconnect', {
          // DUP-DEBUG: every reattach re-subscribes onEvent. If logs show
          // multiple reattaches without a matching detach in between, walnut
          // may be accumulating event handlers on the conn.
          rsmId: this._rsmId,
          host: this.hostKey, sid: this._sid,
          fromOffset: fromOffset === Number.MAX_SAFE_INTEGER ? 'MAX_SAFE_INTEGER (skip replay)' : fromOffset,
        })
        return true
      }
      log.session.warn('RemoteSessionManager: reattach failed', {
        host: this.hostKey, sid: this._sid, error: result.error,
      })
      return false
    } catch (err) {
      log.session.warn('RemoteSessionManager: reattach exception', {
        host: this.hostKey, sid: this._sid,
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  // ── Messaging ──

  /**
   * `dedupe`: this line may already be in the CLI (an earlier attempt's outcome
   * is unknown), so a daemon with send-dedupe-v1 writes nothing when it can tell
   * what became of it, and says so through `onFate` (line-fate-core.ts).
   *
   * Throws SendOutcomeUnknownError when the request may have reached the daemon
   * and no answer came even after asking again: the caller must not take that
   * as "not delivered" (stopping the CLI and resending would run it twice).
   * Lines already queued behind that one are not written (they would overtake
   * it): they throw SendHeldError and go back to the queue behind it.
   */
  writeMessage(message: string, opts?: LineWriteOptions): Promise<boolean> {
    // One user line at a time: a line whose outcome is still being asked about
    // must not be overtaken by the next one (the daemon writes in arrival order).
    const seq = ++this._writeSeq
    const held = opts?.onHeld
    if (held) {
      if (this._confirming) held()
      else this._waitingWrites.add(held)
    }
    const run = this._writeChain.then(() => {
      if (held) this._waitingWrites.delete(held)
      return this.writeMessageNow(message, opts, seq)
    })
    this._writeChain = run.then(() => {}, () => {})
    return run
  }

  private _writeChain: Promise<void> = Promise.resolve()
  private _writeSeq = 0
  /** Writes up to this sequence number were queued behind a held or unconfirmed line. */
  private _heldThrough = 0
  /** A line's answer is being asked for; lines queued behind it are told. */
  private _confirming = false
  private _waitingWrites = new Set<() => void>()

  private async writeMessageNow(message: string, opts: LineWriteOptions | undefined, seq: number): Promise<boolean> {
    if (seq <= this._heldThrough) throw new SendHeldError()
    if (this.conn?.connected && this.cloudLink) this.closeCloudLink()
    // A daemon refusal lets processNext stop and resume the old process. Losing
    // the link proves nothing about that process: try the same line through the
    // cloud send route, or keep it queued. An unanswered native request takes
    // confirmSend instead; it must not switch paths without knowing its fate.
    if (!this._sid) return false

    // Capture conn/sid synchronously — they may change during the async image upload
    // (e.g. renameForSession(), detach(), or a concurrent start() call).
    const conn = this.conn
    const sid = this._sid
    let orderedMarkers = conn?.connected ? conn.hasCapability('send-markers-v1') : false
    let cloudTried = false
    const viaCloud = async (prepared: string): Promise<Record<string, unknown> | null> => {
      if (cloudTried || IS_EPHEMERAL || !this.isRemote || this.hostKey === '__cloudbox__'
        || !opts?.uuid || !opts.markers?.length || findLocalImagePaths(message).length > 0) return null
      cloudTried = true
      await this.ensureCloudLink(sid)
      const { postToCloudSessionSend } = await import('../core/cloud-ingest.js')
      const rewriteKey = Number.isInteger(opts.lostPid) && opts.lostPid! > 1 ? `${sid}\n${opts.uuid}` : null
      const rewrite = rewriteKey !== null && !this.rewriteAlreadyAttempted(sid, opts)
      const result = await this.dispatch(sid, opts.stopFence, () => {
        opts.onDispatch?.()
        if (rewrite) {
          this.cloudRewriteAttempts.delete(rewriteKey!)
          this.cloudRewriteAttempts.set(rewriteKey!, { pid: opts.lostPid!, generation: opts.lostGeneration ?? 0 })
          if (this.cloudRewriteAttempts.size > 64) this.cloudRewriteAttempts.delete(this.cloudRewriteAttempts.keys().next().value!)
        }
        return postToCloudSessionSend({
          host: this.hostKey, sessionId: sid, message: prepared, uuid: opts.uuid!, markers: opts.markers!,
          stopFence: opts.stopFence ?? null,
          ...(rewrite ? { lostPid: opts.lostPid } : {}),
        })
      })
      // Null is a proven not-sent result. Unknown retains the attempt, so
      // retrying this line asks for its fate instead of forcing another copy.
      if (result === null && rewrite) this.cloudRewriteAttempts.delete(rewriteKey!)
      // The cloud route accepts only a daemon that writes ordered markers.
      if (result) orderedMarkers = true
      return result
    }

    try {
      const prepared = conn?.connected ? await this.prepareOutbound(message) : message
      this._lastPreparedOutbound = prepared
      // `uuid` is spread, never passed as an explicit undefined: an old daemon
      // sees exactly the payload it always saw when no uuid was assigned.
      const confirmable = orderedMarkers && !!opts?.markers?.length && (conn?.hasCapability(SEND_DEDUPE_CAPABILITY) ?? false)
      // `rewrite`: the first send of a line the CLI read past carries lostPid. The
      // confirmSend resend never does: its question is whether THAT write landed,
      // and the record it just made answers it (a lostPid would write a third copy).
      const payload = (c: DaemonConnection, dedupe: boolean, rewrite = true) => ({
        sid, message: prepared, ...(opts?.uuid ? { uuid: opts.uuid } : {}),
        ...(c.hasCapability('cron-supervision-v1') ? { stopFence: opts?.stopFence ?? null } : {}),
        ...(c.hasCapability('send-markers-v1') && opts?.markers?.length ? { markers: opts.markers } : {}),
        ...(dedupe ? { dedupe: true } : {}),
        ...(rewrite && dedupe && opts?.lostPid != null && c.hasCapability(SEND_LOST_LINE_CAPABILITY)
          && !this.rewriteAlreadyAttempted(sid, opts) ? { lostPid: opts.lostPid } : {}),
      })
      const sendNative = async (): Promise<Record<string, unknown>> => {
        // send-boot-wait-v1: only the first ask of the first line after a start waits through the boot.
        const bootWait = opts?.bootWait === true && conn!.hasCapability(SEND_BOOT_WAIT_CAPABILITY)
        let reply = await this.dispatch(sid, opts?.stopFence, () => {
          opts?.onDispatch?.()
          const body = payload(conn!, confirmable && opts?.dedupe === true)
          return bootWait
            ? conn!.send('send', { ...body, bootWait: true }, RemoteSessionManager.BOOT_WAIT_SEND_TIMEOUT_MS)
            : conn!.send('send', body)
        })
        const reason = String(reply.reason || reply.error || '')
        if (reply.ok || (reason !== 'not_found' && reason !== 'not found')) return reply
        // Missing registry is not process death. Attach rediscovers the daemon's
        // stream and pgid, without changing mode or replacing a live process.
        let found: Record<string, unknown>
        try { found = await conn!.send('attach', { sid, fromOffset: this.attachFromOffset() }) }
        catch { throw new SendHeldError('Not sent yet: the session host could not rediscover the process') }
        if (this.conn !== conn || this._sid !== sid || !found.ok || typeof found.alive !== 'boolean') {
          throw new SendHeldError('Not sent yet: the session host could not confirm the process identity')
        }
        if (!found.alive && found.state !== 'dead') throw new SendHeldError('Not sent yet: the session host could not confirm the process')
        if (found.alive) {
          this._pid = typeof found.pid === 'number' ? found.pid : this._pid
          this._hasPipe = true
          if (typeof found.currentOffset === 'number' && found.currentOffset > this._fileSize) this.adoptCursor(found.currentOffset)
        }
        // Attach's disk rediscovery alone is not a death verdict. Ask send
        // again: only its explicit session_dead/ENXIO result allows recovery.
        if (found.alive && !confirmable) throw new SendHeldError('Not sent yet: the rediscovered host cannot dedupe the user line')
        reply = await this.dispatch(sid, opts?.stopFence, () => {
          opts?.onDispatch?.()
          return conn!.send('send', payload(conn!, true))
        })
        return reply
      }
      let result: Record<string, unknown>
      if (!conn?.connected) {
        const cloud = await viaCloud(prepared)
        if (!cloud) throw new SendHeldError('Not sent yet: waiting for the connection to the session host')
        result = cloud
      } else {
        try {
          result = await sendNative()
        } catch (err) {
          if (isSessionStopSuperseded(err)) throw err
          const kind = linkFailureKind(err)
          const notSent = kind === 'no-link'
            || (kind === null && err instanceof Error && /^DaemonConnection not connected to\b/.test(err.message))
          if (notSent) {
            const cloud = await viaCloud(prepared)
            if (!cloud) throw new SendHeldError('Not sent yet: waiting for the connection to the session host')
            result = cloud
          } else {
            if (!sendMayHaveLanded(err)) throw err
            try {
              if (!confirmable) throw new SendOutcomeUnknownError(err instanceof Error ? err.message : String(err))
              result = await this.confirmSend(sid, (c) => payload(c, true, false), opts, err)
            } catch (unknown) {
              if (unknown instanceof SendOutcomeUnknownError) this._heldThrough = this._writeSeq
              throw unknown
            }
          }
        }
      }
      if (result.ok && result.duplicate === true) {
        opts?.onFate?.({
          fate: String(result.fate ?? 'waiting'), ...(typeof result.state === 'string' ? { state: result.state } : {}),
          // How long the process has been still (line-fate-core.ts); older daemons send neither.
          ...(typeof result.writtenAt === 'number' ? { writtenAt: result.writtenAt } : {}),
          ...(result.quiet === true ? { quiet: true as const } : {}),
        })
      }
      // Written, but behind a cut copy of the line that the CLI will exit on: the
      // write is no proof of delivery, so the caller keeps the line (onCut).
      if (result.ok && result.cut === true) {
        log.session.warn('RemoteSessionManager: line written behind a cut copy of it', { host: this.hostKey, sid, uuid: opts?.uuid ?? null })
        opts?.onCut?.()
      }
      if (result.ok) {
        if (!orderedMarkers) {
          for (const marker of opts?.markers ?? []) this.writeSyntheticUserEvent(marker.message, marker.messageId)
        }
        // Bump lastEventAt on successful delivery. Without this, the
        // SessionHealthMonitor idle-timeout check (default 30 min) uses a
        // stale last-JSONL-event timestamp and can kill a session that was
        // idle for >30 min but just received a fresh user message — the
        // remote CLI is actively working on the new turn, but health monitor
        // sees no inbound JSONL event yet and assumes the session is dead.
        // (Local sessions don't hit this because their lastEventAt is derived
        // from file mtime, and the FIFO write updates the file.)
        this._lastEventAt = Date.now()
        return true
      }

      const reason = String(result.reason || result.error || '')
      if (reason === 'budget_paused') throw new BudgetPausedError()
      if (reason === 'budget_checking') throw new BudgetCheckingError()
      if (reason === 'session_stopped') throw new SessionStopSupersededError('Session delivery was superseded by a stop request')
      // Only the daemon's death verdict permits stop/resume. EAGAIN is an
      // intact, full pipe; not_found and identity refusals do not prove death.
      // Legacy partial-write verdicts are terminal because the CLI's stdin is
      // corrupted (current daemons reap and return session_dead instead).
      const remoteDied = reason === 'ENXIO'
        || reason === 'session_dead'
        || reason === 'partial_write'
        || reason === 'partial write'
      log.session.warn('RemoteSessionManager: send failed', {
        host: this.hostKey, sid, reason,
        exitCode: result.exitCode ?? null,
        remoteDied,
        willFireExit: remoteDied && this._hasPipe,
      })
      if (remoteDied) {
        if (cloudTried && !this.conn?.connected) {
          throw new SendHeldError('Not sent yet: the session process needs native recovery')
        }
        if (this._hasPipe) {
          this._hasPipe = false
          // Pass the daemon's REAL exit code, not a hardcoded 1. When the CLI
          // exited cleanly at a turn boundary (daemon normalizes to exitCode 0
          // via isTurnCompleteExit), this lets the onExit handler's `code !== 0`
          // gate short-circuit — _hasPipe cleanup still runs, but no bogus
          // session:error is emitted. The send still returns false so the
          // caller falls back to --resume and recovers the session. Hardcoding
          // 1 here turned every clean turn-end-at-send-time into a fake crash.
          // Legacy partial_write deaths have no normalized exitCode.
          this._onExit?.((result.exitCode as number | undefined) ?? 1)
        }
        return false
      }
      throw new SendHeldError(`Not sent yet: the session host refused delivery (${reason || 'unknown reason'})`)
    } catch (err) {
      // A budget or test-server gate refusal is an answer: nothing was written, so later lines are not held behind it.
      if (isSessionStopSuperseded(err) || err instanceof BudgetPausedError || err instanceof BudgetCheckingError
        || err instanceof InheritedSessionRefusedError) throw err
      if (err instanceof SendOutcomeUnknownError || err instanceof SendHeldError) {
        this._heldThrough = this._writeSeq
        log.session.warn('RemoteSessionManager: send outcome unknown', { host: this.hostKey, sid, error: err.message })
        throw err
      }
      const linkFailure = linkFailureKind(err)
      // Preparation can race a disconnect before send reaches the socket. An
      // older connection emits the same refusal without its no-link tag.
      this._heldThrough = this._writeSeq
      if (linkFailure === 'no-link' || (linkFailure === null && err instanceof Error && /^DaemonConnection not connected to\b/.test(err.message))) {
        throw new SendHeldError('Not sent yet: waiting for the connection to the session host')
      }
      log.session.warn('RemoteSessionManager: send error', {
        host: this.hostKey, error: err instanceof Error ? err.message : String(err),
      })
      throw new SendHeldError(`Not sent yet: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * The send's request may have reached the daemon, but its answer never came
   * (a stuck host, a one-way backlog, a socket that closed with it pending).
   * Ask the daemon again with the SAME line and `dedupe`: it writes nothing when
   * it can tell what became of the line and writes it otherwise, so the answer
   * is the delivery itself, exactly once. Never stop the CLI over this: it is
   * usually alive and already answering the line. Lines queued behind this one
   * are told they wait (onHeld). Gives up (throws SendOutcomeUnknownError) after
   * SEND_CONFIRM_DEADLINE_MS with no answer, or at once when the user stops the
   * session (the stopped line must not be delivered after the Stop).
   */
  private async confirmSend(
    sid: string,
    payload: (conn: DaemonConnection) => Record<string, unknown>,
    opts: LineWriteOptions | undefined,
    first: unknown,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + RemoteSessionManager.SEND_CONFIRM_DEADLINE_MS
    let last = first instanceof Error ? first.message : String(first)
    let pause = 1_000
    log.session.warn('RemoteSessionManager: send unanswered, asking the daemon whether the line landed', { host: this.hostKey, sid, error: last })
    this._confirming = true
    for (const held of this._waitingWrites) held()
    this._waitingWrites.clear()
    try {
      for (let attempt = 1; Date.now() < deadline; attempt++) {
        if (opts?.isStopped?.()) throw new SendOutcomeUnknownError(`${last}; the session was stopped while the host was being asked`)
        try {
          // A pooled connection reconnects itself; a fresh instance needs our listener.
          // A private one (a test daemon url) is never replaced here: that would leak it.
          const pooled = this._directWsUrl
            ? this.hostKey === '__local__' && process.env.WALNUT_LOCAL_CONN_POOL !== '0'
            : !!this.sshTarget
          if (!this.conn?.connected && pooled) {
            const before = this.conn
            await this.ensureConnected()
            if (this.conn !== before) this.rebindEventListener()
          }
          const conn = this.conn
          if (conn?.connected) {
            // Reconnected to a daemon that cannot dedupe: a resend could run the line twice.
            if (!conn.hasCapability(SEND_DEDUPE_CAPABILITY)) throw new SendOutcomeUnknownError(`${last}; the host's daemon cannot confirm delivery`)
            const result = await this.dispatch(sid, opts?.stopFence, () =>
              conn.send('send', payload(conn), RemoteSessionManager.SEND_CONFIRM_ATTEMPT_MS))
            log.session.info('RemoteSessionManager: send outcome confirmed', {
              host: this.hostKey, sid, attempt, ok: result.ok === true, duplicate: result.duplicate === true,
              fate: result.fate ?? null, reason: result.reason ?? result.error ?? null,
            })
            return result
          }
          last = 'not connected'
        } catch (err) {
          if (isSessionStopSuperseded(err) || err instanceof SendOutcomeUnknownError) throw err
          last = err instanceof Error ? err.message : String(err)
        }
        const until = Date.now() + Math.max(0, Math.min(pause, deadline - Date.now()))
        while (Date.now() < until && !opts?.isStopped?.()) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(200, until - Date.now())))
        }
        pause = Math.min(pause * 2, 8_000)
      }
      throw new SendOutcomeUnknownError(last)
    } finally {
      this._confirming = false
    }
  }

  canRewriteLostLine(): boolean {
    const conn = this.conn
    return this.cloudLink?.connected === true || (!!conn?.connected && conn.hasCapability('send-markers-v1')
      && conn.hasCapability(SEND_DEDUPE_CAPABILITY) && conn.hasCapability(SEND_LOST_LINE_CAPABILITY))
  }

  async writeRaw(json: string): Promise<boolean> {
    // control_response for --permission-prompt-tool stdio. Routed through the
    // daemon's `sendRaw` command (daemon-core.handleSendRawCommand), which
    // writes the line to the session FIFO without the `{type:"user",...}`
    // wrapping that cmdSend applies.
    if (!this._sid) return false
    if (!this.conn?.connected) {
      if (IS_EPHEMERAL || !this.isRemote || this.hostKey === '__cloudbox__') return false
      let raw: Record<string, unknown>
      try { raw = JSON.parse(json) as Record<string, unknown> } catch { return false }
      const response = raw?.response as Record<string, unknown> | undefined
      const answer = response?.response as Record<string, unknown> | undefined
      const requestId = response?.request_id
      if (raw?.type !== 'control_response' || response?.subtype !== 'success' || typeof requestId !== 'string'
        || (answer?.behavior !== 'allow' && answer?.behavior !== 'deny')
        || !this.knownPermissionRequests.has(requestId)) return false
      const updated = answer.updatedInput as { answers?: unknown } | undefined
      const answers = this.knownPermissionRequests.get(requestId) === 'AskUserQuestion' ? updated?.answers : undefined
      if (answers !== undefined && (!answers || typeof answers !== 'object' || Array.isArray(answers)
        || Object.values(answers).some((value) => typeof value !== 'string'))) return false
      const sid = this._sid
      try {
        await this.ensureCloudLink(sid)
        const generation = this.cloudGeneration
        const { postToCloudSessionPermission } = await import('../core/cloud-ingest.js')
        const result = await postToCloudSessionPermission({
          host: this.hostKey, sessionId: sid, requestId, allow: answer.behavior === 'allow',
          ...(typeof answer.message === 'string' ? { message: answer.message } : {}),
          ...(answers !== undefined ? { answers: answers as Record<string, string> } : {}),
        })
        if (generation !== this.cloudGeneration || sid !== this._sid || !result?.ok) return false
        if (this.cloudPendingRequest?.id === requestId) this.cloudPendingRequest = null
        return true
      } catch { return false }
    }
    if (this.cloudLink) this.closeCloudLink()
    const conn = this.conn
    const sid = this._sid
    try {
      const result = await conn.send('sendRaw', { sid, raw: json })
      if (result.ok) return true
      const reason = String(result.reason || result.error || '')
      // See note in send() for why partial_write must be treated as terminal.
      const remoteDied = reason === 'ENXIO'
        || reason === 'session_dead'
        || reason === 'partial_write'
        || reason === 'partial write'
      log.session.warn('RemoteSessionManager: writeRaw failed', {
        host: this.hostKey, sid, reason,
        exitCode: result.exitCode ?? null,
        remoteDied,
      })
      if (remoteDied) {
        if (this._hasPipe) {
          this._hasPipe = false
          // Real exit code, not hardcoded 1 — see note in send(). A clean
          // turn-end (exitCode 0) must not be reported as a crash.
          this._onExit?.((result.exitCode as number | undefined) ?? 1)
        }
      }
      return false
    } catch (err) {
      log.session.warn('RemoteSessionManager: writeRaw error', {
        host: this.hostKey, error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  writeSyntheticUserEvent(message: string, walnutMessageId: string): void {
    // Turn-start marker: ask the daemon to append a walnut-injected user line
    // to the session's stream file at the delivery point. The CLI never echoes
    // stdin user messages to stream-json stdout, so without this the stream
    // file has turn ENDs (result) but no turn STARTs — the reconciler's
    // backward anchor scan then lands on a PREVIOUS turn and adopts its stale
    // result as the current turn's verdict (incident inc-1783644415695).
    // Fire-and-forget: a failure (old daemon without the RPC, transient
    // disconnect) only degrades reconcile precision — the fold's positional
    // and init-invalidation rules still guard against a stale-result verdict.
    if (!this.conn?.connected || !this._sid) return
    this.conn.send('appendUserMarker', { sid: this._sid, message, messageId: walnutMessageId })
      .then((result) => {
        if (result?.ok !== true) {
          log.session.debug('appendUserMarker declined', {
            host: this.hostKey, sid: this._sid, reason: (result as { reason?: string })?.reason,
          })
        }
      })
      .catch((err) => {
        log.session.debug('appendUserMarker failed (non-fatal)', {
          host: this.hostKey, sid: this._sid,
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }

  async setMode(mode: string): Promise<boolean> {
    if (!this.conn?.connected || !this._sid) return false
    try {
      const result = await this.conn.send('setMode', { sid: this._sid, mode })
      return result.ok === true
    } catch {
      return false
    }
  }

  // ── Process Control ──

  async stop(reason: 'user' | 'maintenance' | 'idle' = 'maintenance'): Promise<void> {
    if (!this.conn?.connected || !this._sid) {
      log.session.info('RemoteSessionManager.stop: skipped', {
        host: this.hostKey, sid: this._sid,
        connConnected: !!this.conn?.connected, hasSid: !!this._sid,
      })
      throw new Error(`DaemonConnection not connected to ${this.hostKey}; stop was not confirmed`)
    }

    // Every stop names this Walnut (owner-home-v1): the daemon refuses one for a
    // session its spawn journal records for another Walnut. This path drives a
    // live session this server holds, so it counts as 'human' (stop-provenance.ts).
    const provenance = stopProvenance(this.conn, reason === 'idle' ? 'automatic' : 'human')
    if (!provenance) {
      log.session.info('RemoteSessionManager.stop: not sent, the daemon cannot check ownership', { host: this.hostKey, sid: this._sid })
      throw new Error(STOP_NOT_SENT_NO_OWNERSHIP_CHECK)
    }
    log.session.info('RemoteSessionManager.stop: sending stop cmd to daemon', { host: this.hostKey, sid: this._sid })
    try {
      const result = await this.conn.send('stop', { sid: this._sid, reason, ...provenance }, 10_000)
      if (result.ok !== true || result.stopped !== true) throw new Error(describeStopRefusal(result))
      log.session.info('RemoteSessionManager.stop: daemon acked', {
        host: this.hostKey, sid: this._sid, result,
      })
    } catch (err) {
      log.session.warn('RemoteSessionManager: stop error', {
        host: this.hostKey, sid: this._sid,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  kill(reason: 'user' | 'maintenance' | 'idle' = 'maintenance'): void {
    if (!this.conn?.connected || !this._sid) {
      log.session.info('RemoteSessionManager.kill: skipped', {
        host: this.hostKey, sid: this._sid,
        connConnected: !!this.conn?.connected, hasSid: !!this._sid,
      })
      return
    }

    const provenance = stopProvenance(this.conn, reason === 'idle' ? 'automatic' : 'human')
    if (!provenance) {
      log.session.info('RemoteSessionManager.kill: not sent, the daemon cannot check ownership', { host: this.hostKey, sid: this._sid })
      return
    }
    log.session.info('RemoteSessionManager.kill: sending stop cmd to daemon (fire-and-forget)', {
      host: this.hostKey, sid: this._sid,
    })
    // Fire-and-forget — but log the outcome so we can tell if daemon actually received it
    this.conn.send('stop', { sid: this._sid, reason, ...provenance })
      .then(result => log.session.info('RemoteSessionManager.kill: daemon acked', {
        host: this.hostKey, sid: this._sid, result,
      }))
      .catch(err => log.session.warn('RemoteSessionManager.kill: daemon error', {
        host: this.hostKey, sid: this._sid,
        error: err instanceof Error ? err.message : String(err),
      }))
    this._hasPipe = false
  }

  /** Same outcomes as stopThroughOwner: a daemon's answer other than stopped is 'refused'. */
  async stopForIdle(): Promise<import('../core/sessions/owner-stop.js').OwnerStopOutcome> {
    if (!this.conn?.connected || !this._sid) return 'unreachable'
    const provenance = stopProvenance(this.conn, 'automatic')
    if (!provenance) return 'refused'
    try {
      const result = await this.conn.send('stop', { sid: this._sid, reason: 'idle', ...provenance }, 10_000)
      if (result.ok !== true || result.stopped !== true) {
        log.session.info('RemoteSessionManager.stopForIdle: daemon declined', {
          host: this.hostKey, sid: this._sid, why: describeStopRefusal(result),
        })
        return 'refused'
      }
      this._hasPipe = false
      return 'stopped'
    } catch { return 'unknown' }
  }

  async interrupt(): Promise<void> {
    await this.stop('maintenance')
    this._hasPipe = false
  }

  async isAlive(): Promise<boolean> {
    if (!this._sid) return false
    if (this.conn?.connected && this.cloudLink) this.closeCloudLink()
    if (this.cloudLink?.connected) {
      if (this.cloudAlive === false) return false
      if (this.cloudAlive === true && Date.now() - this.cloudEventAt < 5 * 60_000) return true
      // A connected scoped stream without recent evidence is unknown, not
      // proof the process died on the disconnected native transport.
      return this._hasPipe
    }

    // Disconnected ≠ dead. Short disconnects (< 5min) → assume alive, wait for reconnect.
    // Long disconnects (> 5min) → let health monitor mark error. Counted in AWAKE time:
    // a Mac that slept with the link down is not 5 minutes into an outage on waking
    // (awake-down-clock.ts; 2026-10-30, nine live sessions declared dead at a wake).
    if (!this.conn?.connected) {
      const downMs = this.conn?.disconnectedAwakeMs?.() ?? 0
      if (downMs > 5 * 60 * 1000) {
        return false // exceeded grace period
      }
      return true // short disconnect — assume process is still alive
    }

    try {
      const result = await this.conn.send('status', { sid: this._sid })
      return result.ok === true && result.alive === true
    } catch {
      return true // send failed (possibly reconnecting) — assume alive
    }
  }

  /** L2: PULL the daemon-authoritative background-task state (the source of truth). Returns null
   *  when we can't reach the daemon (disconnected) or it doesn't support getState (old binary —
   *  capability handshake will have forced a redeploy, but be defensive) — callers must treat
   *  null as "no authoritative answer, keep current state", NOT as "no work". */
  async getState(): Promise<DaemonTaskState | null> {
    if (!this._sid || !this.conn?.connected) return null
    try {
      const result = await this.conn.send('getState', { sid: this._sid }) as DaemonGetStateResult
      if (!result.ok) return null
      if (result.exists === false) return null // daemon has no record — no authoritative task state
      return result.taskState ?? null
    } catch {
      return null // send failed (reconnecting / unsupported) — no authoritative answer
    }
  }

  // ── Session Management ──

  renameForSession(sessionId: string): void {
    if (!this._sid || this._sid === sessionId) return
    this.closeCloudLink()
    this.knownPermissionRequests.clear()

    const oldSid = this._sid
    this._prevSid = oldSid  // Keep old sid for event matching during async rename
    this._sid = sessionId

    // Rename remote files via daemon.
    // IMPORTANT: Do NOT clear _prevSid on rename completion. The daemon may still
    // emit events with the old sid for in-flight JSONL lines that were queued before
    // the rename was processed. _prevSid is kept for the lifetime of this manager
    // to ensure no events are dropped during the rename transition.
    if (this.conn?.connected) {
      this.conn.send('rename', { oldSid, newSid: sessionId }).catch((err) => {
        log.session.warn('RemoteSessionManager: rename failed', {
          host: this.hostKey, oldSid, newSid: sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
  }

  // Single entry point for (re)binding the daemon event listener. ALWAYS
  // unsubscribes the previous handler before registering a new one, so the
  // shared pooled DaemonConnection never accumulates duplicate handlers for
  // this RSM. Duplicate registration was the root cause of streamed text
  // doubling ("TheThe pl pl…"): the same JSONL line dispatched twice in one
  // tick, and no-uuid stream_event deltas bypassed _seenUuids dedup. Every
  // start/attach/reconnect path MUST route through here, never call
  // conn.onEvent() directly.
  private rebindEventListener(): void {
    if (this.unsubscribeEvent) {
      this.unsubscribeEvent()
      this.unsubscribeEvent = null
    }
    this.unsubscribeEvent = this.conn!.onEvent((event) => this.handleDaemonEvent(event))
  }

  detach(): void {
    this.closeCloudLink()
    // DUP-DEBUG: pair this with "attached to session" by rsmId. If a session
    // duplication-bug repro shows two `attached to session` for the same sid
    // without a `detach` for the older rsmId, we have an RSM leak.
    log.session.info('RemoteSessionManager: detach', {
      rsmId: this._rsmId,
      host: this.hostKey,
      sid: this._sid,
      hadEventSubscription: this.unsubscribeEvent !== null,
    })
    if (this.unsubscribeEvent) {
      this.unsubscribeEvent()
      this.unsubscribeEvent = null
    }
    this._onOutput = null
    this._onExit = null
  }

  async cleanup(): Promise<void> {
    this.detach()
    // Session ended — free the per-session caches that live for its whole
    // (possibly multi-hour) lifetime. Done in cleanup(), NOT detach(): detach()
    // is also the temporary-disconnect path, and the daemon may replay cached
    // events after a detach but before re-attach, so clearing there would drop
    // dedup state mid-reconnect. cleanup() = real teardown, safe to clear.
    this._imageCache.clear()
    this._seenUuids.clear()
    this.cloudRewriteAttempts.clear()
    this.knownPermissionRequests.clear()
  }

  deletePipe(): void {
    this._hasPipe = false
  }

  // ── Message Processing ──

  async prepareOutbound(message: string): Promise<string> {
    // Local daemon: same filesystem — no path rewriting needed
    if (!this.isRemote) return message
    if (!this.conn?.connected) return message

    let rewritten = message

    // Upload local images to remote host via daemon (path rewritten to remote location)
    const imagePaths = findLocalImagePaths(message)
    for (const localPath of imagePaths) {
      try {
        const data = fs.readFileSync(localPath)
        // Beside the daemon dir (/tmp/open-walnut-images, or ~/.cache/open-walnut-images
        // when /tmp is unusable on this host): never inside it, which fs.write refuses.
        const remotePath = `${this.conn.remoteDaemonDir || '/tmp/open-walnut'}-images/${path.basename(localPath)}`

        const result = await this.conn.send('fs.write', {
          path: remotePath,
          data: data.toString('base64'),
          encoding: 'base64',
        })
        // send() RESOLVES with {ok:false} on a daemon-side error — it only
        // throws on transport failure. Rewriting regardless pointed the CLI at
        // a remote path that was never written, so Claude got a bogus
        // "file not found" for a path the user never typed. Keep the original
        // local path on failure (the SCP-era transfer had the same contract).
        if (!result.ok) {
          log.session.warn('RemoteSessionManager: image upload rejected by daemon — keeping local path', {
            localPath, remotePath, host: this.hostKey, error: result.error,
          })
          continue
        }

        rewritten = rewritten.split(localPath).join(remotePath)
      } catch (err) {
        log.session.warn('RemoteSessionManager: image upload failed', {
          localPath, error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return rewritten
  }

  /**
   * Upload a Quick Start spill file to the remote host at the same absolute path.
   * Both local and remote use /tmp/ so the path identity holds. Throws on failure
   * — callers (start()) treat a missing spill file as fatal because Claude's
   * pointer prompt references it.
   */
  private async uploadSpillFile(localPath: string): Promise<void> {
    if (!this.conn?.connected) {
      throw new Error(`Cannot upload spill file: daemon not connected (host "${this.hostKey}")`)
    }
    const data = fs.readFileSync(localPath)
    const result = await this.conn.send('fs.write', {
      path: localPath,
      data: data.toString('base64'),
      encoding: 'base64',
    })
    // send() RESOLVES with {ok:false} on a daemon-side error and only THROWS on
    // transport failure (daemon-connection.ts resolves every reply regardless of
    // `ok`). Without this check the doc comment above was a lie: a rejected write
    // logged "uploaded spill file" and returned successfully, and the session then
    // started with a pointer prompt referencing a file that does not exist on the
    // remote host — so Claude reads nothing and the Quick Start context is silently
    // lost. Same defect as prepareOutbound had; keep both checked.
    if (!result.ok) {
      throw new Error(
        `Failed to upload spill file to host "${this.hostKey}": ${result.error ?? 'daemon rejected fs.write'}`,
      )
    }
    log.session.info('RemoteSessionManager: uploaded spill file to remote', {
      path: localPath, size: data.length, host: this.hostKey,
    })
  }

  processInbound(text: string, sessionId: string, cwd?: string, opts?: { streaming?: boolean }): string {
    // Local daemon: same filesystem — no path rewriting needed
    if (!this.isRemote) return text

    // Streaming deltas are partial text: a path split across two deltas leaves
    // fragments at the chunk edges that match as complete paths/filenames and
    // would be rewritten into garbage (observed: "weekly-trend.png" split into
    // "…week" + "ly-trend.png" → "…week/tmp/…/<sid>/ly-trend.png"). Skip edge
    // matches; the turn-end full-text and history-replay rewrites (complete
    // text) cover them.
    const findOpts = opts?.streaming ? { excludeEdges: true } : undefined

    // Download remote images and rewrite paths to local
    const remotePaths = findImagePaths(text, findOpts)
    let rewritten = text
    const localHome = process.env.HOME || '/root'

    for (const remotePath of remotePaths) {
      // Skip local paths, and anything that already is (or embeds) a mirror slot
      // — see looksAlreadyMirrored; the same guard exists in session-history.ts.
      if (remotePath.startsWith(localHome) || remotePath.startsWith(REMOTE_IMAGES_DIR)) continue
      if (looksAlreadyMirrored(remotePath)) continue

      let localPath = this._imageCache.get(remotePath)
      if (!localPath) {
        // Hash-keyed slot (falls back to a legacy bare-basename mirror only when
        // its sidecar proves the same origin) — two dirs' same-named chart.png
        // must not share one slot.
        localPath = resolveSessionMirrorPath(sessionId, remotePath)
        this._imageCache.set(remotePath, localPath)

        if (!fs.existsSync(localPath)) {
          // Download via daemon fs.read (fire-and-forget), published so the <img>
          // that can arrive before the bytes waits for them (remote-image-mirror.ts).
          const lp = localPath
          startMirrorDownload(lp, () => this.downloadRemoteFile(remotePath, lp)).catch(() => {})
        } else {
          // Pre-sidecar mirror file — record origin so it can be revalidated.
          backfillMirrorSidecar(localPath, this.hostKey, remotePath)
        }
      }
      rewritten = rewritten.split(remotePath).join(localPath)
    }

    // Handle relative image names
    if (cwd) {
      const relNames = findRelativeImageNames(rewritten, findOpts)
      for (const relName of relNames) {
        // A relative name can embed a mirror slot; joining it onto cwd invents a
        // path no host has ever had. Same guard as session-history.ts.
        if (looksAlreadyMirrored(relName)) continue
        const cwdPath = `${cwd.replace(/\/$/, '')}/${relName}`

        if (this._imageCache.has(cwdPath)) continue

        let localPath = this._imageCache.get(`rel:${relName}`)
        if (!localPath) {
          // Slot keyed by the cwd-resolved source path — see the absolute-path
          // branch above for why bare basenames collide.
          localPath = resolveSessionMirrorPath(sessionId, cwdPath)
          this._imageCache.set(`rel:${relName}`, localPath)

          if (!fs.existsSync(localPath)) {
            const lp = localPath
            startMirrorDownload(lp, () => this.downloadRemoteFile(cwdPath, lp)).catch(() => {})
          } else {
            backfillMirrorSidecar(localPath, this.hostKey, cwdPath)
          }
        }

        const escaped = relName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const nameRe = new RegExp(`(?<=^|[\\s"'\`=:(])${escaped}(?=[\\s"'\`),;\\]}]|$)`, 'g')
        rewritten = rewritten.replace(nameRe, () => localPath!)
      }
    }

    return rewritten
  }

  // ── Streaming Control ──

  flushTail(): void {
    // No-op for daemon — events are already delivered via WebSocket
  }

  stopTail(): void {
    // No-op — handled by detach/unsubscribe
  }

  // ── Private ──

  private handleDaemonEvent(event: DaemonEvent): void {
    if (!this._sid) return
    if (this.conn?.connected && this.cloudLink) this.closeCloudLink()
    if (event.ev === 'jsonl' && event.sid === this._sid && event.line) {
      try {
        const raw = JSON.parse(event.line) as { type?: string; request_id?: string; request?: { tool_name?: string }; response?: { request_id?: string } }
        if (raw.type === 'control_request' && typeof raw.request_id === 'string') {
          this.cloudPendingRequest = { id: raw.request_id, toolName: raw.request?.tool_name ?? '' }
          this.rememberPermission(raw.request_id, raw.request?.tool_name ?? '')
        } else if ((raw.type === 'control_response' && raw.response?.request_id === this.cloudPendingRequest?.id)
          || (raw.type === 'control_cancel_request' && raw.request_id === this.cloudPendingRequest?.id)) {
          this.cloudPendingRequest = null
        }
      } catch { /* the existing output parser handles malformed lines */ }
    }

    switch (event.ev) {
      case 'jsonl':
        if ((event.sid === this._sid || event.sid === this._prevSid) && event.line) {
          // The idle clock: Walnut's own control exchanges do not count (stream-activity.ts).
          if (isConversationActivityLine(event.line)) this._lastEventAt = Date.now()

          // L1 version-skip (preferred path when the daemon stamps `v`). `v` is the byte
          // offset at the END of this line — monotonic per session, identical live vs replay.
          // A single comparison kills BOTH duplicates and out-of-order replay: anything we've
          // already advanced past is dropped. When present, `v` is also the authoritative
          // cursor (more reliable than locally summing line bytes), so we adopt it directly.
          if (typeof event.v === 'number') {
            if (event.v <= this._lastSeenV) return // already delivered (dup / out-of-order replay) — skip
            this.adoptCursor(event.v) // v is the authoritative absolute cursor; keeps the watermark in sync
          } else {
            // Old daemon (no `v`): advance the cursor by line bytes and fall back to uuid dedup.
            this._fileSize += Buffer.byteLength(event.line + '\n', 'utf-8') // feeds fromOffset in retryStartAfterReconnect()
          }

          // UUID-based dedup. The daemon's cmdAttach catch-up may replay
          // bytes that were already delivered via realtime push before a
          // tunnel flap; and any future fullResync path will also replay.
          // Skip lines whose uuid we've already forwarded. Lines without a
          // uuid (e.g. system/init) always pass through — they're rare and
          // usually idempotent at the UI layer anyway.
          //
          // DUP-DEBUG: log uuid + dedup outcome for tool_use / tool_result
          // lines so duplication can be traced. Two log lines for the same
          // uuid means the daemon pushed the same line twice; two lines from
          // different rsmId means walnut has leaked RSM instances.
          let uuid: string | null = null
          let lineKind: string | null = null
          try {
            const parsed = JSON.parse(event.line) as {
              uuid?: unknown
              type?: unknown
              message?: { content?: Array<{ type?: unknown }> }
            }
            uuid = typeof parsed.uuid === 'string' ? parsed.uuid : null
            // Only flag the line types we care about for the duplicate-render bug.
            if (parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
              const types = parsed.message.content.map((b) => b?.type).filter(Boolean)
              if (types.includes('tool_use')) lineKind = 'tool_use'
            } else if (parsed.type === 'user' && Array.isArray((parsed as { message?: { content?: Array<{ type?: unknown }> } }).message?.content)) {
              const types = (parsed as { message: { content: Array<{ type?: unknown }> } }).message.content.map((b) => b?.type).filter(Boolean)
              if (types.includes('tool_result')) lineKind = 'tool_result'
            }
            if (uuid) {
              const dup = this._seenUuids.has(uuid)
              if (lineKind) {
                // debug: fires per remote JSONL line (tool_use/result/text) — a
                // streaming hot path. Surface via WALNUT_LOG_LEVEL=debug.
                log.session.debug('RSM jsonl received', {
                  rsmId: this._rsmId,
                  sid: this._sid,
                  uuid,
                  lineKind,
                  dedupHit: dup,
                  seenUuidCount: this._seenUuids.size,
                })
              }
              if (dup) return
              this._seenUuids.add(uuid)
              // Bounded FIFO: evict oldest once over cap (Set keeps insertion order).
              if (this._seenUuids.size > RemoteSessionManager.SEEN_UUID_CAP) {
                const oldest = this._seenUuids.values().next().value
                if (oldest !== undefined) this._seenUuids.delete(oldest)
              }
            } else if (lineKind) {
              log.session.debug('RSM jsonl received (no uuid)', {
                rsmId: this._rsmId, sid: this._sid, lineKind,
              })
            }
          } catch {
            // Non-JSON or malformed line — pass through. Downstream parser
            // will log and skip; we don't second-guess it.
          }

          // Past both duplicate checks: a replayed old state must not overwrite a newer one.
          const cliState = cliStateOf(event.line)
          if (cliState) this._cliState = cliState

          // Forward to handler, carrying the L1 byte-offset version when the
          // daemon stamped one (consumers use it as the consumed watermark).
          this._onOutput?.({ line: event.line, v: typeof event.v === 'number' ? event.v : undefined })
        }
        break

      case 'exit':
        if (event.sid === this._sid || event.sid === this._prevSid) {
          this._lastEventAt = Date.now()
          this._hasPipe = false
          this._onExit?.(event.code ?? 1, event.stderr)
        }
        break

      case 'session_state':
        // Daemon-authoritative state broadcast (running | dead). On dead,
        // fire onExit so the session runner transitions to stopped. This is
        // a backstop for cases where the `exit` event is lost (rare) and also
        // the single entry point for daemon-side reap detection (idle scan,
        // reconcile, ENXIO pre-check, orphan poll).
        if (event.sid === this._sid || event.sid === this._prevSid) {
          const state = event.state as string | undefined
          if (state === 'dead') {
            this._lastEventAt = Date.now()
            if (this._hasPipe) {
              this._hasPipe = false
              // The daemon's stderr tail rides this broadcast too: without it a CLI
              // that failed at startup (exit 1 and its message) read as a bare code.
              this._onExit?.((event.exitCode as number | undefined) ?? 1,
                typeof event.stderr === 'string' ? event.stderr : undefined)
            }
          }
        }
        break

      case 'stderr_tail':
        // Emitted by daemon on every `result` JSONL record. Log-only for now —
        // grep this when a stuck/empty-result turn happens to see what the remote
        // Claude CLI wrote to stderr (MCP init errors, validation failures, etc).
        if ((event.sid === this._sid || event.sid === this._prevSid) && typeof event.tail === 'string') {
          log.session.info('RemoteSessionManager: CLI stderr tail', {
            // DUP-DEBUG: rsmId tagged. If the same daemon-pushed stderr_tail
            // appears with two different rsmIds, we have leaked RSM instances.
            rsmId: this._rsmId,
            sessionId: this._sid, sid: event.sid, tail: event.tail,
          })
        }
        break

      case 'snapshot':
        // C2 intake: daemon-authoritative SessionSnapshot push (contract §5).
        // Route into the projection layer; NEVER let a failure escape the
        // event handler (same discipline as the sibling cases).
        if ((event.sid === this._sid || event.sid === this._prevSid) && event.snapshot) {
          // Capability guard: a daemon that pushes snapshots necessarily
          // supports them, but if this connection's hello EXPLICITLY advertised
          // a capability set without snapshot-v1, treat the event as protocol
          // noise. Unknown caps (connectDirect skips hello) pass — the event
          // itself is the evidence.
          if (this.conn && this.conn.capabilitiesKnown && !this.conn.supportsSnapshots) break
          const sid = event.sid === this._prevSid && this._sid ? this._sid : event.sid
          import('../core/session-snapshot-apply.js')
            .then(({ applySnapshot }) => applySnapshot(sid!, event.snapshot as never, 'daemon-push'))
            .catch((err) => {
              log.session.warn('RemoteSessionManager: snapshot apply failed', {
                host: this.hostKey, sid: event.sid,
                error: err instanceof Error ? err.message : String(err),
              })
            })
          // Cron sync (independent of the snapshot-status mode): the daemon's
          // full-file fold is the cron authority — walnut's own attach fold is
          // tail-window-bounded, so a CronCreate hours back is invisible to it.
          // One-way arm (never dis-arm from a push: snapshotDiffers may
          // suppress an unchanged-cron push, so absence proves nothing; the
          // live CronDelete handler is the dis-arm path).
          if ((event.snapshot as { cronActive?: boolean }).cronActive === true) {
            import('./claude-code-session.js')
              .then(({ sessionRunner }) => {
                const live = sessionRunner.findSessionByClaudeId(sid!)
                if (live) live.setCronArmedFromSnapshot()
              })
              .catch(() => { /* runner not loaded — attach-only */ })
          }
        }
        break

      case 'agent':
        // Subagent events — forward as-is (handled by session-chat.ts)
        break
    }
  }

  /**
   * Download a file from the remote host via daemon fs.read. Records a
   * .src.json sidecar so /api/local-image can later revalidate the mirror
   * against the remote source (regenerated charts must not stay stale).
   * Resolves true once the bytes are on disk.
   */
  private async downloadRemoteFile(remotePath: string, localPath: string): Promise<boolean> {
    if (!this.conn?.connected) return false
    // A path the host already said it does not have is not going to be there this
    // render either, and the rewrite paths re-derive their candidate list from
    // scratch every time. Shared with downloadToMirror so both entry points honour
    // one cache. Only a real not-found is remembered — a transport failure or a
    // local write error says nothing about whether the file exists.
    if (fetchRecentlyMissing(this.hostKey, remotePath)) return false

    try {
      const dir = path.dirname(localPath)
      fs.mkdirSync(dir, { recursive: true })

      const result = await this.conn.send('fs.read', { path: remotePath, encoding: 'base64' })
      if (!result.ok || typeof result.data !== 'string') {
        if (isNotFoundReply(result)) noteFetchMissing(this.hostKey, remotePath)
        return false
      }
      noteFetchFound(this.hostKey, remotePath)
      const buf = Buffer.from(result.data, 'base64')
      fs.writeFileSync(localPath, buf)
      const st = await this.conn.send('fs.stat', { path: remotePath }).catch(() => null)
      writeMirrorSidecar(localPath, {
        host: this.hostKey,
        remotePath,
        remoteMtimeMs: st?.ok && st.exists ? (st.mtimeMs as number) : 0,
        remoteSize: st?.ok && st.exists ? (st.size as number) : buf.length,
      })
      return true
    } catch (err) {
      log.session.warn('RemoteSessionManager: file download failed', {
        remotePath, localPath,
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }
}

// ── Helpers ──

/** Match daemon connection errors that are worth retrying after reconnect.
 *  Same predicate as isDaemonCommandOutcomeUnknown — a connection-class failure
 *  means the command outcome is unknown, which is exactly what makes the
 *  reconnect+probe retry worthwhile. */
function isDaemonConnError(err: unknown): boolean {
  return isDaemonCommandOutcomeUnknown(err)
}

// Re-export for convenience
export { findLocalImagePaths, findRemoteImagePaths, findRelativeImageNames }
