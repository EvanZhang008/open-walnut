/**
 * ACP host worker — one per Walnut session, ordinary daemon child.
 *
 * Topology (docs/plan/coding-agent-acp-provider.md):
 *   daemon ──(NDJSON JSON-RPC on THIS process's stdio)── worker (this file)
 *     worker ──(ACP over the adapter child's stdio)── codex-acp ── provider
 *
 * Ownership: this process owns the ACP ClientSideConnection, the adapter child,
 * the pending-permission table, commandId dedup, and the append-only journal.
 * The daemon tracks its detached process group and sweeps it on restart;
 * recovery is lazy session/load from a fresh worker.
 *
 * The worker deliberately does NOT interpret provider frames: sessionUpdate and
 * requestPermission frames land raw in the journal; the Walnut server
 * normalizes on read. Keep it that way — display logic here would freeze
 * mapping bugs into a process we can't hot-fix.
 */

import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { Writable, Readable } from 'node:stream'
import readline from 'node:readline'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
} from '@agentclientprotocol/sdk'
import type {
  McpServer,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  PermissionOptionId,
} from '@agentclientprotocol/sdk'
import { AcpJournal, readJournal } from './journal.js'
import { redactSensitiveText } from '../../logging/redact.js'
import { mergeAcpSpawnEnv, OP_REFUSAL_KINDS, snapshotAcpTurnUsage } from './protocol.js'
import { matchesUsageLimitText, parseUsageLimitReset } from '../usage-limit-text.js'
import { CodexDirectConnection, type AcpClientHandler } from '../codex-app-server/connection.js'
import { CodexLaunchError, prepareCodexLaunch } from '../codex-app-server/launch.js'
import { AppServerRpcError } from '../codex-app-server/rpc.js'
import { classifyCodexFailure } from '../codex-app-server/errors.js'
import { CODEX_TRANSPORT_ENV, describeResumeFailure } from '../codex-app-server/transport.js'
import type {
  AcpMcpServer,
  WorkerRequest,
  WorkerResponse,
  WorkerError,
  InitializeParams,
  NewSessionParams,
  LoadSessionParams,
  PromptParams,
  SteerParams,
  CancelParams,
  SetConfigOptionParams,
  PermissionResponseParams,
  WorkerStateSnapshot,
  PendingPermissionSnapshot,
} from './protocol.js'
import {
  EMPTY_ACP_CAPABILITIES,
  snapshotAcpCapabilities,
  snapshotAcpConfigOptions,
  snapshotAcpModels,
  type AcpCapabilitySnapshot,
  type AcpConfigOption,
  type AcpModelCatalog,
  type AcpFrameSource,
} from './protocol.js'

interface PendingPermission {
  snapshot: PendingPermissionSnapshot
  resolve: (resp: RequestPermissionResponse) => void
}


/**
 * Ops whose failure the caller handles itself, never a turn that failed: a steer that missed the
 * live turn goes back to Walnut's queue and into the next turn (acp-session.ts steer returns false
 * on any failure). Every other op's failure is journaled as an error row, which reads as a failed
 * session. tests/providers/acp-worker-op-failures.test.ts lists every op with its choice.
 */
export const CALLER_OWNS_FAILURE: ReadonlySet<string> = new Set(['steer'])

export class AcpWorker {
  private journal: AcpJournal
  private adapter: ChildProcess | null = null
  private conn: ClientSideConnection | null = null
  /** Set when this session talks to `codex app-server` itself (codex-app-server/connection.ts), in the adapter's place. */
  private direct: CodexDirectConnection | null = null
  private providerSessionId: string | null = null
  private cwd = ''
  private turnActive = false
  /** What ended most recently — decides who owns a chunk that arrives in the
   *  gap between prompts. Providers may resolve the prompt RPC BEFORE flushing
   *  the turn's final message chunks (opencode does), and those stragglers are
   *  still the USER's reply; a control prompt's stragglers stay control. */
  private lastEnded: 'turn' | 'control' | null = null
  private turnCommandId: string | null = null
  private controlPrompt: { commandId: string; purpose: 'self-report'; toolRefused?: boolean } | null = null
  private loadingSession = false
  /** True while a resume's replay burst must be dropped instead of journaled
   * (set in opLoadSession when the journal already holds the conversation). */
  private skipReplayFrames = false
  /** providerRequestId → live JSON-RPC resolver. Dies with the process (by design). */
  private pendingPermissions = new Map<string, PendingPermission>()
  private toolCalls = new Map<string, RequestPermissionRequest['toolCall']>()
  private permissionSeq = 0
  /** Per-process nonce folded into permission ids. A bare `perm-${seq}` counter
   * restarts at 1 in every replacement worker, so a stale UI card from a dead
   * worker could alias a LIVE request in the new one and approve the wrong
   * thing. The nonce makes ids unique across worker generations. */
  private readonly permissionNonce = crypto.randomBytes(4).toString('hex')
  /** op+commandId → original result, rebuilt from the journal on every worker start. */
  private acceptedCommands = new Map<string, { op: string; commandId: string; result: unknown }>()
  private lastAcceptedCommands = new Map<string, string>()
  private onJournalAppend: (offset: number) => void
  private onAdapterStderr: (bytes: number) => void
  private onAdapterGone: () => void
  private onProviderError: (report: ProviderErrorReport) => void
  /** Set by shutdown: the adapter's exit is then the one asked for. */
  private shuttingDown = false

  private readonly journalPath: string
  constructor(
    journalPath: string,
    onJournalAppend: (offset: number) => void = () => {},
    onAdapterStderr: (bytes: number) => void = () => {},
    onAdapterGone: () => void = () => {},
    onProviderError: (report: ProviderErrorReport) => void = () => {},
  ) {
    this.journalPath = journalPath
    this.journal = new AcpJournal(journalPath)
    this.onJournalAppend = onJournalAppend
    this.onAdapterStderr = onAdapterStderr
    this.onAdapterGone = onAdapterGone
    this.onProviderError = onProviderError
    this.rebuildAcceptedCommands(journalPath)
  }

  get journalOffset(): number { return this.journal.offset }

  // ── Op handlers ──

  async handle(req: WorkerRequest): Promise<WorkerResponse> {
    try {
      switch (req.op) {
        case 'initialize':        return this.ok(req, await this.opInitialize(req.params as unknown as InitializeParams))
        case 'newSession':        return this.ok(req, await this.opNewSession(req.params as unknown as NewSessionParams))
        case 'loadSession':       return this.ok(req, await this.opLoadSession(req.params as unknown as LoadSessionParams))
        case 'prompt':            return this.ok(req, await this.opPrompt(req.params as unknown as PromptParams))
        case 'steer':             return this.ok(req, await this.opSteer(req.params as unknown as SteerParams))
        case 'cancel':            return this.ok(req, await this.opCancel(req.params as unknown as CancelParams))
        case 'permissionResponse':return this.ok(req, this.opPermissionResponse(req.params as unknown as PermissionResponseParams))
        case 'setConfigOption':    return this.ok(req, await this.opSetConfigOption(req.params as unknown as SetConfigOptionParams))
        case 'getState':          return this.ok(req, this.opGetState())
        case 'shutdown':          return this.ok(req, await this.opShutdown())
        default:
          return this.err(req, { kind: 'protocol', message: `unknown op: ${(req as WorkerRequest).op}` })
      }
    } catch (e) {
      const adapterError = asObject(asObject(e).data)
      const werr: WorkerError = isWorkerError(e) ? e : {
        kind: classifyPromptRejection(e) === 'auth_required' ? 'auth_required'
          : adapterError.walnutError === 'provider_incompatible' ? 'provider_incompatible'
            : adapterError.walnutError === 'provider_missing' ? 'provider_missing' : 'internal',
        message: e instanceof Error ? e.message : String(e),
      }
      const safeError = sanitizeWorkerError(werr, adapterError.provider)
      // A WorkerError is Walnut's own wrap: its provider words, if any, were reported where it was made.
      if (!isWorkerError(e)) this.reportProviderError(req.op, safeError.kind, e)
      const control = req.op === 'prompt'
        && (req.params as Partial<PromptParams> | undefined)?.control === 'self-report'
      const recoverableLoadFailure = req.op === 'loadSession' && werr.kind === 'load_failed'
      // A steer that did not apply (any reason) and a prompt refused because a turn
      // runs change nothing about the turn: the caller keeps the message queued.
      // Journaled as an `error`, it read as the LIVE turn's failure, and the server's
      // turn-error path drove the queue again at once, which steered again (2026-11-09).
      const refusal = !control && (CALLER_OWNS_FAILURE.has(req.op) || OP_REFUSAL_KINDS.has(werr.kind))
      const journaled = !recoverableLoadFailure && !refusal
      if (recoverableLoadFailure || refusal) {
        // The caller acts on this answer itself (a steer that missed goes back to its queue and
        // into the next turn): no turn failed, so nothing reaches the journal (2026-11-09: a steer
        // that met the live turn's end read as an error row and Needs you).
        // session/load is lifecycle setup, not a user turn. The caller may
        // immediately create a replacement provider thread; journaling this as
        // a turn error would leak into chat and transiently poison status/phase
        // before the intentional identity-boundary warning.
      } else if (control) {
        this.journal.appendMeta({
          type: 'control-ended',
          commandId: String(req.params?.commandId ?? 'unknown'),
          stopReason: 'error',
          error: safeError.message,
        })
      } else {
        this.journal.appendMeta({
          type: 'error',
          errorKind: safeError.kind,
          message: safeError.message,
        })
      }
      if (journaled) this.notifyJournal()
      return this.err(req, safeError)
    }
  }

  /** The provider's own words for a failure go to the daemon's log, redacted, and never to the journal. */
  private reportProviderError(op: string, kind: WorkerError['kind'], error: unknown): void {
    const detail = providerErrorDetail(error)
    if (detail) this.onProviderError({ op, kind, detail })
  }

  private async opInitialize(params: InitializeParams): Promise<unknown> {
    if (this.conn) return { alreadyInitialized: true }
    this.cwd = params.cwd
    if (params.env?.[CODEX_TRANSPORT_ENV] === 'app-server') return this.initializeDirect(params)

    const [cmd, ...cmdArgs] = params.adapterCommand ?? []
    if (!cmd) throw <WorkerError>{ kind: 'adapter_spawn_failed', message: 'empty adapterCommand' }
    const adapter = spawn(cmd, cmdArgs, {
      cwd: params.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Same unset semantics as the daemon's worker spawn: '' deletes. A raw
      // re-merge here resurrected env vars the daemon had already unset.
      env: mergeAcpSpawnEnv(process.env, params.env),
    })
    await new Promise<void>((resolve, reject) => {
      adapter.once('spawn', resolve)
      adapter.once('error', (e) => reject(<WorkerError>{ kind: 'adapter_spawn_failed', message: e.message }))
    })
    this.adapter = adapter
    adapter.on('exit', () => {
      // Adapter death mid-turn = the turn is gone (no hot reattach exists).
      // A worker is one adapter: without it every later op fails as "protocol"
      // while the worker still reads as alive, so the daemon never cold-resumes
      // it (2026-10-30: an OpenCode lane whose provider died answered every
      // later message with an instant failure). Going away hands it to the
      // daemon's reap, and the next send starts a fresh worker that loads the
      // session again.
      this.adapterExited('ACP adapter exited')
    })
    // Adapter stderr may contain credentials or auth diagnostics. Drain it so
    // the child cannot block, but expose only a byte count to the daemon.
    adapter.stderr!.on('data', (chunk: Buffer | string) => {
      this.onAdapterStderr(Buffer.byteLength(chunk))
    })

    const stream = ndJsonStream(
      Writable.toWeb(adapter.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(adapter.stdout!) as ReadableStream<Uint8Array>,
    )
    this.conn = new ClientSideConnection(() => this.buildClientHandler(), stream)

    const initResp = await this.conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        // MVP: no fs/terminal capability modules yet — advertise only what has
        // a durable implementation (per plan: unadvertised until then).
        fs: { readTextFile: false, writeTextFile: false },
      },
      clientInfo: { name: 'open-walnut', version: '0.2.0' },
    })
    this.initializeResponse = initResp
    this.capabilities = snapshotAcpCapabilities(initResp)
    return initResp
  }

  /** The adapter (or the app-server it stood for) is gone: the turn with it, and this worker. */
  private adapterExited(what: string): void {
    if (this.turnActive) {
      const commandId = this.turnCommandId ?? undefined
      this.turnActive = false
      this.turnCommandId = null
      this.journal.appendMeta({ type: 'turn-interrupted', reason: 'worker-crash', commandId })
      this.notifyJournal()
    }
    if (this.controlPrompt) this.finishControlPrompt(this.controlPrompt.commandId, 'worker-crash', what)
    this.failAllPendingPermissions()
    if (!this.shuttingDown) this.onAdapterGone()
  }

  private async initializeDirect(params: InitializeParams): Promise<unknown> {
    const env = mergeAcpSpawnEnv(process.env, params.env)
    let launch
    try {
      launch = await prepareCodexLaunch(env)
    } catch (e) {
      if (e instanceof CodexLaunchError) throw <WorkerError>{ kind: e.kind, message: e.message, walnutWords: true }
      throw e
    }
    const direct = new CodexDirectConnection(launch, params.cwd, env, this.buildClientHandler() as unknown as AcpClientHandler, {
      // The failed turn was journaled first (its prompt rejected); then this worker goes, and the next send starts a fresh one.
      onExit: () => this.adapterExited('Codex app-server exited'),
      onStderr: (bytes) => this.onAdapterStderr(bytes),
    })
    try {
      const initResp = await direct.initialize()
      this.direct = direct
      this.conn = direct as unknown as ClientSideConnection
      this.initializeResponse = initResp
      this.capabilities = snapshotAcpCapabilities(initResp)
      return initResp
    } catch (e) {
      direct.kill()
      throw <WorkerError>{ kind: 'adapter_spawn_failed', message: `Codex app-server did not start: ${e instanceof Error ? e.message : String(e)}`, walnutWords: true }
    }
  }

  private initializeResponse: unknown = null
  private capabilities: AcpCapabilitySnapshot = { ...EMPTY_ACP_CAPABILITIES }
  private sessionResponse: unknown = null
  private models: AcpModelCatalog = { availableModels: [] }
  private configOptions: AcpConfigOption[] = []

  /**
   * MCP mounts for session/new + session/load. The SAME list must ride both:
   * ACP treats `mcpServers` as the complete set for the session being
   * created OR loaded, so a mount present only on `new` silently disappears on
   * the next cold resume. Absent option = `[]` = pre-mount behavior.
   */
  private mcpServersFor(params: { mcpServers?: AcpMcpServer[] }): McpServer[] {
    const servers = params.mcpServers ?? []
    // Structurally an McpServerStdio (name/command/args/env) — see protocol.ts.
    return servers.map((server) => ({
      name: server.name,
      command: server.command,
      args: [...server.args],
      env: (server.env ?? []).map((entry) => ({ name: entry.name, value: entry.value })),
    }))
  }

  private async opNewSession(params: NewSessionParams): Promise<unknown> {
    const conn = this.requireConn()
    const resp = await conn.newSession({
      cwd: params.cwd || this.cwd,
      mcpServers: this.mcpServersFor(params),
    })
    this.providerSessionId = resp.sessionId
    this.sessionResponse = resp
    this.models = snapshotAcpModels(resp)
    this.configOptions = snapshotAcpConfigOptions(resp)
    this.journal.appendMeta({ type: 'session-created', providerSessionId: resp.sessionId })
    this.notifyJournal()
    return resp
  }

  private async opLoadSession(params: LoadSessionParams): Promise<unknown> {
    const conn = this.requireConn()
    const useLoad = this.capabilities.loadSession || !this.capabilities.resumeSession
    this.loadingSession = useLoad
    // The journal already holds this conversation, so the provider's replay
    // burst is pure duplication (see the sessionUpdate handler). Gate on
    // EVIDENCE of the conversation being on disk, not on this.journal.offset:
    // the in-memory offset stays non-zero after the file is deleted under us
    // (retention sweep / rm), and a journal holding only an error meta line is
    // non-empty without holding any conversation — both cases must keep the
    // replay or the conversation becomes unrecoverable (the journal is
    // walnut's only copy).
    this.skipReplayFrames = useLoad && journalHoldsConversation(this.journal.filePath)
    try {
      const request = {
        sessionId: params.providerSessionId,
        cwd: params.cwd || this.cwd,
        mcpServers: this.mcpServersFor(params),
      }
      const resp = this.direct
        // The app-server resumes without a replay; it sends the past turns only when the journal lost them.
        ? await this.direct.loadSession({ sessionId: request.sessionId, cwd: request.cwd, mcpServers: params.mcpServers, replay: !this.skipReplayFrames })
        : useLoad
          ? await conn.loadSession(request)
          : await conn.resumeSession(request)
      this.providerSessionId = params.providerSessionId
      this.sessionResponse = resp
      this.models = snapshotAcpModels(resp)
      this.configOptions = snapshotAcpConfigOptions(resp)
      this.journal.appendMeta({ type: 'session-loaded', providerSessionId: params.providerSessionId })
      this.notifyJournal()
      return resp
    } catch (e) {
      if (this.direct) throw this.directLoadFailure(params.providerSessionId, e)
      if (classifyPromptRejection(e) === 'auth_required' || ['provider_incompatible', 'provider_missing'].includes(String(asObject(asObject(e).data).walnutError))) throw e
      // The words ride the adapter's error data, which the wrap below drops.
      this.reportProviderError('loadSession', 'load_failed', e)
      throw <WorkerError>{ kind: 'load_failed', message: e instanceof Error ? e.message : String(e) }
    } finally {
      this.loadingSession = false
      this.skipReplayFrames = false
    }
  }

  /**
   * Why a direct resume failed, said plainly. Only a thread Codex does not have is
   * `load_failed` (the caller then starts a fresh thread, and the journal's
   * resume-failed record says why in the chat); a timeout or a dead app-server is
   * a failure of this start, so nothing replaces the conversation behind its back.
   * A thread Codex has but cannot resume (an unreadable copy, a provider no longer
   * configured) fails the start too, and only the RESUME_GIVE_UP-th failure in a row
   * for the same reason moves on to a new thread, saying so and where the old one is.
   */
  private directLoadFailure(threadId: string, e: unknown): WorkerError {
    this.reportProviderError('loadSession', 'load_failed', e)
    const reason = describeResumeFailure(e)
    if (reason.kind === 'not_found') {
      this.journal.appendMeta({ type: 'resume-failed', providerSessionId: threadId, reason: reason.words })
      this.notifyJournal()
      return { kind: 'load_failed', message: reason.words, walnutWords: true }
    }
    if (reason.kind === 'other') {
      const inARow = resumeErrorsInARow(this.journalPath, threadId, reason.words) + 1
      this.journal.appendMeta({ type: 'resume-error', providerSessionId: threadId, reason: reason.words })
      this.notifyJournal()
      if (inARow >= RESUME_GIVE_UP) {
        const words = `${reason.words}. It failed ${inARow} times in a row; Codex still keeps the earlier conversation on this host as thread ${threadId}`
        this.journal.appendMeta({ type: 'resume-failed', providerSessionId: threadId, reason: words })
        this.notifyJournal()
        return { kind: 'load_failed', message: words, walnutWords: true }
      }
      if (classifyPromptRejection(e) === 'auth_required') return { kind: 'auth_required', message: 'ACP provider authentication is required' }
      // Say what happens next: the next message tries again, and the last try moves on.
      const left = RESUME_GIVE_UP - inARow
      const next = left === 1
        ? 'The next message tries once more; if that fails too, Walnut starts a new conversation and names this thread.'
        : `The next message tries again; after ${left} more failures in a row Walnut starts a new conversation and names this thread.`
      return { kind: 'protocol', message: `${reason.words}. ${next}`, walnutWords: true }
    }
    if (classifyPromptRejection(e) === 'auth_required') return { kind: 'auth_required', message: 'ACP provider authentication is required' }
    return { kind: reason.kind === 'exited' ? 'app_server_exited' : 'protocol', message: reason.words, walnutWords: true }
  }

  private async opPrompt(params: PromptParams): Promise<unknown> {
    if (params.control === 'self-report') return this.opControlPrompt(params)
    const dup = this.checkDuplicate('prompt', params.commandId)
    if (dup) return dup
    const conn = this.requireConn()
    if (!this.providerSessionId) throw <WorkerError>{ kind: 'no_session', message: 'no provider session — call newSession/loadSession first' }
    if (this.turnActive || this.controlPrompt) {
      throw <WorkerError>{ kind: 'turn_active', message: 'a turn is already running — cancel it or wait' }
    }
    if (!params.walnutMessageId) {
      throw <WorkerError>{ kind: 'protocol', message: 'prompt requires walnutMessageId' }
    }

    const acceptedResult = { accepted: true, commandId: params.commandId, walnutMessageId: params.walnutMessageId }
    this.journal.appendMeta({
      type: 'prompt-intent',
      commandId: params.commandId,
      walnutMessageId: params.walnutMessageId,
      text: params.text,
    })
    this.notifyJournal()

    // This is the crash-ambiguity boundary. fdatasync makes both the preceding
    // intent and this fact durable before the provider call can begin. Recovery
    // never blindly retries an attempted dispatch: it exposes an indeterminate
    // turn so the user can inspect provider history and explicitly retry.
    this.journal.appendMeta({
      type: 'prompt-dispatch-attempted',
      commandId: params.commandId,
    }, true)
    this.notifyJournal()
    this.toolCalls.clear()
    this.turnActive = true
    this.turnCommandId = params.commandId

    // The prompt RPC resolves at END of turn. We run it detached from this
    // request's lifetime: the daemon's `prompt` op returns immediately with
    // {accepted:true}; turn progress rides the journal.
    let prompt: ReturnType<ClientSideConnection['prompt']>
    try {
      prompt = conn.prompt({
        sessionId: this.providerSessionId,
        prompt: [{ type: 'text', text: params.text }],
      })
    } catch (error) {
      this.turnActive = false
      this.turnCommandId = null
      this.journal.appendMeta({
        type: 'prompt-abandoned',
        commandId: params.commandId,
        reason: 'dispatch-failed',
      })
      this.notifyJournal()
      throw error
    }

    // Only a prompt whose ACP RPC was initiated is deduplicated after restart.
    // An intent-only crash remains retryable with the same queue command ID.
    this.journal.appendMeta({ type: 'prompt-dispatched', commandId: params.commandId })
    this.rememberAcceptedCommand('prompt', params.commandId, acceptedResult)
    this.journal.appendMeta({
      type: 'prompt-accepted',
      commandId: params.commandId,
      walnutMessageId: params.walnutMessageId,
      text: params.text,
    })
    this.journal.appendMeta({ type: 'turn-started', commandId: params.commandId })
    this.notifyJournal()

    void prompt.then((resp) => {
      if (this.turnCommandId !== params.commandId) return
      this.turnActive = false
      this.turnCommandId = null
      this.lastEnded = 'turn'
      const usage = snapshotAcpTurnUsage((resp as { usage?: unknown }).usage)
      this.journal.appendMeta({ type: 'turn-ended', commandId: params.commandId, stopReason: resp.stopReason, ...(usage ? { usage } : {}) })
      this.notifyJournal()
    }).catch((e) => {
      if (this.turnCommandId !== params.commandId) return
      this.turnActive = false
      this.turnCommandId = null
      this.lastEnded = 'turn'
      // Only the error category is safe to persist; provider diagnostics may contain credentials.
      const kind = this.direct ? classifyDirectRejection(e) : classifyPromptRejection(e)
      this.reportProviderError('prompt', kind, e)
      // A usage limit's reset is read here, on the host: Codex writes it in the host's local time.
      const resetsAt = kind === 'usage_limit' ? parseUsageLimitReset(rejectionText(e), Date.now()) : undefined
      this.journal.appendMeta({
        type: 'error',
        errorKind: kind,
        message: safeWorkerErrorMessage(kind),
        commandId: params.commandId,
        ...(resetsAt ? { resetsAt } : {}),
      })
      this.journal.appendMeta({
        type: 'turn-interrupted',
        reason: 'worker-crash',
        commandId: params.commandId,
      })
      this.notifyJournal()
    })
    return acceptedResult
  }

  /**
   * Mid-turn steering: inject text into the LIVE turn via the adapter's
   * `_session/steering` extension (codex `turn/steer` underneath). The model
   * folds the text into its next inference step — no queue wait, no interrupt.
   *
   * Contract with the caller (drainAcpQueue):
   * - only valid while a turn is running AND the adapter advertised steering;
   *   otherwise a typed error tells the caller to fall back to prompt/queue.
   * - outcome 'injected' → joined the running turn (owner commandId = that
   *   turn's), journal gets steer-accepted so history shows the user message.
   * - outcome 'startedNewTurn' means the turn ended mid-flight and the adapter
   *   ran the text as a NEW turn it now owns — our turnActive bookkeeping never
   *   saw that turn start, so we conservatively report steer_race and let the
   *   caller's queue redeliver (adapter-side turn is deduped by commandId).
   */
  private async opSteer(params: SteerParams): Promise<unknown> {
    const dup = this.checkDuplicate('steer', params.commandId)
    if (dup) return dup
    const conn = this.requireConn()
    if (!this.providerSessionId) throw <WorkerError>{ kind: 'no_session', message: 'no provider session — call newSession/loadSession first' }
    if (!this.capabilities.steering || !this.capabilities.steeringInjectOnly) {
      throw <WorkerError>{ kind: 'steer_unsupported', message: 'adapter does not support mid-turn steering' }
    }
    if (!this.turnActive || this.controlPrompt) {
      throw <WorkerError>{ kind: 'no_turn', message: 'no live turn to steer into' }
    }
    if (!params.walnutMessageId) {
      throw <WorkerError>{ kind: 'protocol', message: 'steer requires walnutMessageId' }
    }

    const accepted = {
      accepted: true,
      steered: true,
      commandId: params.commandId,
      walnutMessageId: params.walnutMessageId,
    }
    let recorded = false
    // Recorded once: when the direct client sees Codex report the steer (before anything Codex
    // sends after it, so the person's line comes ahead of its answer), else on the answer.
    const record = () => {
      if (recorded) return
      recorded = true
      this.rememberAcceptedCommand('steer', params.commandId, accepted)
      this.journal.appendMeta({
        type: 'steer-accepted',
        commandId: params.commandId,
        walnutMessageId: params.walnutMessageId,
        text: params.text,
      })
      this.notifyJournal()
    }

    let outcome: string | undefined
    try {
      const resp = await conn.extMethod('_session/steering', {
        sessionId: this.providerSessionId,
        prompt: [{ type: 'text', text: params.text }],
        // Never a turn of its own: the caller sends a text that missed the live turn as its next
        // prompt, so an adapter that started one ran it twice (Walnut's codex-acp patch honours it).
        injectOnly: true,
        ...(this.direct ? { onTaken: record } : {}),
      })
      outcome = (resp as { outcome?: string } | undefined)?.outcome
    } catch (e) {
      throw <WorkerError>{ kind: 'protocol', message: e instanceof Error ? e.message : String(e) }
    }

    if (outcome !== 'injected') {
      // 'noActiveTurn' | 'failed' (| 'startedNewTurn' from an adapter that ignores injectOnly): the
      // live turn is gone (or codex refused: review/compact turns are non-steerable). Typed error,
      // and the caller re-queues it for the next turn.
      throw <WorkerError>{ kind: 'steer_race', message: 'live turn ended before steering applied' }
    }

    record()
    return accepted
  }

  private opControlPrompt(
    params: Extract<PromptParams, { control: 'self-report' }>,
  ): unknown {
    const dup = this.checkDuplicate('controlPrompt', params.commandId)
    if (dup) return dup
    const conn = this.requireConn()
    if (!this.providerSessionId) {
      throw <WorkerError>{ kind: 'no_session', message: 'no provider session — call newSession/loadSession first' }
    }
    if (this.turnActive || this.controlPrompt) {
      throw <WorkerError>{ kind: 'turn_active', message: 'a turn is already running — cancel it or wait' }
    }

    const acceptedResult = {
      accepted: true,
      commandId: params.commandId,
      control: params.control,
    }
    this.rememberAcceptedCommand('controlPrompt', params.commandId, acceptedResult)
    this.controlPrompt = { commandId: params.commandId, purpose: params.control }
    this.journal.appendMeta({
      type: 'control-prompt-accepted',
      commandId: params.commandId,
      purpose: params.control,
    })
    this.notifyJournal()

    // Like a user prompt, ACP resolves at turn end. The immediate accepted
    // response keeps the daemon RPC bounded; output and completion ride the
    // journal as source='control' records consumed privately by AcpSession.
    void conn.prompt({
      sessionId: this.providerSessionId,
      prompt: [{ type: 'text', text: params.text }],
    }).then((resp) => {
      const refused = this.controlPrompt?.commandId === params.commandId && this.controlPrompt.toolRefused
      this.finishControlPrompt(params.commandId, refused ? 'tool-refused' : resp.stopReason)
    }).catch((error) => {
      if (this.controlPrompt?.commandId === params.commandId && this.controlPrompt.toolRefused) {
        this.finishControlPrompt(params.commandId, 'tool-refused')
        return
      }
      this.reportProviderError('prompt', 'protocol', error)
      this.finishControlPrompt(
        params.commandId,
        'error',
        safeWorkerErrorMessage('protocol'),
      )
    })
    return acceptedResult
  }

  /**
   * A status question (the turn-end report, a title, a diff caption) is answered in text,
   * never by acting: a model that starts a tool there ends the question at once. Many
   * adapters run tools with no permission request (OpenCode by default), so the cancelled
   * permission below is not enough. 2026-11-01: an 8B model on OpenCode took the turn-end
   * "update this task's NOTE" as a job, wrote notes.md into the user's repo and started a
   * subagent that created source files. The text before the tool call is kept.
   */
  private refuseControlTool(title: string | undefined): void {
    const control = this.controlPrompt
    if (!control || control.toolRefused) return
    control.toolRefused = true
    this.journal.appendMeta({ type: 'control-tool-refused', commandId: control.commandId, ...(title ? { title } : {}) })
    this.notifyJournal()
    const conn = this.conn
    if (conn && this.providerSessionId) {
      void conn.cancel({ sessionId: this.providerSessionId }).catch(() => {})
      this.failAllPendingPermissions()
    }
  }

  private finishControlPrompt(commandId: string, stopReason: string, error?: string): void {
    if (this.controlPrompt?.commandId !== commandId) return
    this.controlPrompt = null
    this.lastEnded = 'control'
    this.journal.appendMeta({
      type: 'control-ended',
      commandId,
      stopReason,
      ...(error ? { error } : {}),
    })
    this.notifyJournal()
  }

  private async opCancel(params: CancelParams): Promise<unknown> {
    const dup = this.checkDuplicate('cancel', params.commandId)
    if (dup) return dup
    const conn = this.requireConn()
    this.acceptCommand('cancel', params.commandId)
    if (this.direct) {
      // turn/interrupt, answered by the turn's own end: the worker lives on (acp-daemon.ts acpAbortTurn).
      this.failAllPendingPermissions()
      const { turnClosed } = this.providerSessionId && (this.turnActive || this.controlPrompt)
        ? await this.direct.cancel({ sessionId: this.providerSessionId })
        : { turnClosed: true }
      return { cancelled: true, turnClosed }
    }
    if (this.providerSessionId && (this.turnActive || this.controlPrompt)) {
      await conn.cancel({ sessionId: this.providerSessionId })
      // Spec: client MUST answer outstanding permission requests with cancelled.
      this.failAllPendingPermissions()
    }
    return { cancelled: true }
  }

  private opPermissionResponse(params: PermissionResponseParams): unknown {
    const dup = this.checkDuplicate('permissionResponse', params.commandId)
    if (dup) return dup
    const pending = this.pendingPermissions.get(params.providerRequestId)
    if (!pending) {
      // Idempotent-by-observation: already answered (or auto-cancelled) is not an error.
      return { answered: false, reason: 'no_pending_request' }
    }
    this.acceptCommand('permissionResponse', params.commandId)
    this.pendingPermissions.delete(params.providerRequestId)
    pending.resolve(
      params.optionId === null
        ? { outcome: { outcome: 'cancelled' } }
        : { outcome: { outcome: 'selected', optionId: params.optionId as PermissionOptionId } },
    )
    this.journal.appendMeta({ type: 'permission-answered', providerRequestId: params.providerRequestId, optionId: params.optionId })
    this.notifyJournal()
    return { answered: true }
  }

  private async opSetConfigOption(params: SetConfigOptionParams): Promise<unknown> {
    const dup = this.checkDuplicate('setConfigOption', params.commandId)
    if (dup) return dup
    const conn = this.requireConn()
    if (!this.providerSessionId) {
      throw <WorkerError>{ kind: 'no_session', message: 'no provider session — call newSession/loadSession first' }
    }
    if (!params.configId || (typeof params.value !== 'string' && typeof params.value !== 'boolean')) {
      throw <WorkerError>{ kind: 'protocol', message: 'setConfigOption requires configId and a string or boolean value' }
    }
    const request = typeof params.value === 'boolean'
      ? {
          sessionId: this.providerSessionId,
          configId: params.configId,
          value: params.value,
          type: 'boolean' as const,
        }
      : {
          sessionId: this.providerSessionId,
          configId: params.configId,
          value: params.value,
        }
    const resp = await conn.setSessionConfigOption(request)
    this.configOptions = Array.isArray(resp.configOptions)
      ? snapshotAcpConfigOptions(resp)
      : this.configOptions.map((option) => option.id === params.configId && typeof params.value === 'string'
        ? { ...option, currentValue: params.value }
        : option)
    this.sessionResponse = { ...asObject(this.sessionResponse), configOptions: this.configOptions }
    this.models = snapshotAcpModels(this.sessionResponse)
    const accepted = {
      applied: true,
      configId: params.configId,
      value: params.value,
      configOptions: this.configOptions,
      models: this.models,
    }
    this.rememberAcceptedCommand('setConfigOption', params.commandId, accepted)
    this.journal.appendMeta({
      type: 'command-accepted',
      op: 'setConfigOption',
      commandId: params.commandId,
    })
    this.journal.appendMeta({
      type: 'config-option-set',
      configId: params.configId,
      value: params.value,
    })
    this.notifyJournal()
    return accepted
  }

  private opGetState(): WorkerStateSnapshot {
    return {
      providerSessionId: this.providerSessionId,
      adapterPid: this.adapter?.pid ?? this.direct?.pid ?? null,
      turnActive: this.turnActive,
      controlActive: this.controlPrompt !== null,
      pendingPermissions: [...this.pendingPermissions.values()].map((p) => p.snapshot),
      initializeResponse: this.initializeResponse,
      capabilities: this.capabilities,
      sessionResponse: this.sessionResponse,
      models: this.models,
      configOptions: this.configOptions,
      lastAcceptedCommands: Object.fromEntries(this.lastAcceptedCommands),
      journalOffset: this.journal.offset,
    }
  }

  private async opShutdown(): Promise<unknown> {
    this.shuttingDown = true
    if (this.turnActive) {
      this.journal.appendMeta({
        type: 'turn-interrupted',
        reason: 'shutdown',
        commandId: this.turnCommandId ?? undefined,
      })
      this.turnActive = false
      this.turnCommandId = null
      this.notifyJournal()
    }
    if (this.controlPrompt) {
      this.finishControlPrompt(this.controlPrompt.commandId, 'shutdown')
    }
    this.failAllPendingPermissions()
    if (this.direct) await this.direct.close()
    // Close adapter stdin → adapter exits → provider runtime torn down (~2s in codex-acp).
    this.adapter?.stdin?.end()
    const adapter = this.adapter
    if (adapter && adapter.exitCode === null) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { adapter.kill('SIGKILL'); resolve() }, 5000)
        adapter.once('exit', () => { clearTimeout(t); resolve() })
      })
    }
    this.journal.close()
    return { shutdown: true }
  }

  // ── ACP client handler (agent → client calls) ──

  private buildClientHandler(): Client {
    return {
      sessionUpdate: (params: SessionNotification): void => {
        // A resume replays the ENTIRE past conversation as provider-replay
        // frames. When the journal already contains that conversation, writing
        // the burst again on every resume makes an append-only file grow
        // quadratically (a real journal was 100MB, 47MB of it re-replays), and
        // the history projector ignores non-live frames anyway. A FRESH journal
        // (offset 0, e.g. the file was lost) still records the replay so the
        // conversation isn't unrecoverable.
        if (this.loadingSession && this.skipReplayFrames) return
        const update = params.update
        if (update.sessionUpdate === 'tool_call' && this.controlPrompt) this.refuseControlTool(update.title)
        if (update.sessionUpdate === 'tool_call') {
          this.toolCalls.set(update.toolCallId, { toolCallId: update.toolCallId, title: update.title, kind: update.kind, rawInput: update.rawInput })
        } else if (update.sessionUpdate === 'tool_call_update') {
          this.toolCalls.set(update.toolCallId, {
            ...this.toolCalls.get(update.toolCallId), toolCallId: update.toolCallId,
            ...(update.title !== undefined ? { title: update.title } : {}),
            ...(update.kind !== undefined ? { kind: update.kind } : {}),
            ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
          })
        } else if (update.sessionUpdate === 'config_option_update') {
          // A control the provider changed itself: the state snapshot follows (a reattach reads it).
          const next = snapshotAcpConfigOptions(update)
          if (next.length > 0) {
            this.configOptions = next
            this.sessionResponse = { ...asObject(this.sessionResponse), configOptions: next }
          }
        }
        // Raw to journal; zero interpretation here.
        this.journal.appendAcpFrame(
          { method: 'session/update', params },
          this.frameSource(),
        )
        this.notifyJournal()
      },
      requestPermission: (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        const providerRequestId = `perm-${this.permissionNonce}-${++this.permissionSeq}`
        this.journal.appendAcpFrame(
          { method: 'session/request_permission', params, providerRequestId },
          this.frameSource(),
        )
        if (this.controlPrompt) {
          this.notifyJournal()
          return Promise.resolve({ outcome: { outcome: 'cancelled' } })
        }
        this.journal.appendMeta({ type: 'permission-requested', providerRequestId })
        this.notifyJournal()
        return new Promise<RequestPermissionResponse>((resolve) => {
          this.pendingPermissions.set(providerRequestId, {
            snapshot: {
              providerRequestId,
              toolCall: { ...this.toolCalls.get(params.toolCall.toolCallId), ...params.toolCall },
              options: params.options,
              receivedAt: Date.now(),
              ...(params._meta ? { meta: params._meta } : {}),
            },
            resolve,
          })
        })
      },
    }
  }

  /** Answer every outstanding permission with cancelled (turn cancel / adapter death / shutdown). */
  private failAllPendingPermissions(): void {
    for (const [id, pending] of this.pendingPermissions) {
      pending.resolve({ outcome: { outcome: 'cancelled' } })
      this.journal.appendMeta({ type: 'permission-auto-cancelled', providerRequestId: id })
    }
    if (this.pendingPermissions.size > 0) this.notifyJournal()
    this.pendingPermissions.clear()
  }

  // ── Idempotency ──

  private checkDuplicate(op: string, commandId: string): unknown | null {
    const prev = this.acceptedCommands.get(this.commandKey(op, commandId))
    if (prev) return prev.result
    return null
  }

  private acceptCommand(op: string, commandId: string): void {
    const result = op === 'prompt'
      ? { accepted: true, commandId }
      : op === 'cancel' ? { cancelled: true } : { answered: true }
    this.rememberAcceptedCommand(op, commandId, result)
    this.journal.appendMeta({ type: 'command-accepted', op, commandId })
    this.notifyJournal()
  }

  private rememberAcceptedCommand(op: string, commandId: string, result: unknown): void {
    this.acceptedCommands.set(this.commandKey(op, commandId), { op, commandId, result })
    this.lastAcceptedCommands.set(op, commandId)
  }

  private rebuildAcceptedCommands(journalPath: string): void {
    const { records } = readJournal(journalPath)
    let repaired = false
    interface PromptAttempt {
      intent: {
        commandId: string
        walnutMessageId: string
        text: string
      }
      attempted: boolean
      dispatched: boolean
      accepted: boolean
      abandoned: boolean
      terminal: boolean
    }
    const promptAttempts = new Map<string, PromptAttempt>()
    let pendingConfigCommandId: string | undefined

    for (const { record } of records) {
      if (record.kind !== 'meta') continue
      const event = record.event
      if (event.type === 'prompt-intent') {
        // A retry with the same queue command ID starts a new attempt after an
        // intent-only/dispatch-failed attempt. Folding sets would incorrectly
        // let an old abandonment mask this newer attempt.
        promptAttempts.set(event.commandId, {
          intent: event,
          attempted: false,
          dispatched: false,
          accepted: false,
          abandoned: false,
          terminal: false,
        })
      } else if (event.type === 'prompt-dispatch-attempted') {
        const attempt = promptAttempts.get(event.commandId)
        if (attempt) attempt.attempted = true
      } else if (event.type === 'prompt-dispatched') {
        const attempt = promptAttempts.get(event.commandId)
        if (attempt) attempt.dispatched = true
      } else if (event.type === 'prompt-abandoned') {
        const attempt = promptAttempts.get(event.commandId)
        if (attempt) attempt.abandoned = true
      } else if (event.type === 'prompt-accepted') {
        const attempt = promptAttempts.get(event.commandId) ?? {
          intent: event,
          attempted: false,
          dispatched: false,
          accepted: false,
          abandoned: false,
          terminal: false,
        }
        attempt.accepted = true
        promptAttempts.set(event.commandId, attempt)
        this.rememberAcceptedCommand('prompt', event.commandId, {
          accepted: true,
          commandId: event.commandId,
          walnutMessageId: event.walnutMessageId,
        })
      } else if (event.type === 'turn-ended' || event.type === 'turn-interrupted') {
        if (event.commandId) {
          const attempt = promptAttempts.get(event.commandId)
          if (attempt) attempt.terminal = true
        }
      } else if (event.type === 'steer-accepted') {
        this.rememberAcceptedCommand('steer', event.commandId, {
          accepted: true,
          steered: true,
          commandId: event.commandId,
          walnutMessageId: event.walnutMessageId,
        })
      } else if (event.type === 'control-prompt-accepted') {
        this.rememberAcceptedCommand('controlPrompt', event.commandId, {
          accepted: true,
          commandId: event.commandId,
          control: event.purpose,
        })
      } else if (event.type === 'command-accepted') {
        const result = event.op === 'prompt'
          ? { accepted: true, commandId: event.commandId }
          : event.op === 'cancel'
            ? { cancelled: true }
            : { answered: true }
        this.rememberAcceptedCommand(event.op, event.commandId, result)
        pendingConfigCommandId = event.op === 'setConfigOption'
          ? event.commandId
          : undefined
      } else if (event.type === 'config-option-set' && pendingConfigCommandId) {
        this.rememberAcceptedCommand('setConfigOption', pendingConfigCommandId, {
          applied: true,
          configId: event.configId,
          value: event.value,
        })
        pendingConfigCommandId = undefined
      }
    }

    for (const [commandId, attempt] of promptAttempts) {
      // A synchronous dispatch failure or intent-only crash is known not to
      // have crossed the provider boundary and remains retryable with the same
      // durable queue ID.
      if (attempt.abandoned && !attempt.dispatched && !attempt.accepted) continue

      if (!attempt.attempted && !attempt.dispatched && !attempt.accepted) {
        this.journal.appendMeta({
          type: 'prompt-abandoned',
          commandId,
          reason: 'worker-crash',
        })
        repaired = true
        continue
      }

      // Once dispatch was attempted, retrying automatically could duplicate a
      // provider turn. Restore acceptance for queue cleanup and surface a
      // terminal interruption. A pre-call crash is conservatively classified
      // the same way: visible uncertainty is preferable to silent prompt loss.
      this.rememberAcceptedCommand('prompt', commandId, {
        accepted: true,
        commandId,
        walnutMessageId: attempt.intent.walnutMessageId,
      })
      if (!attempt.accepted) {
        this.journal.appendMeta({
          type: 'prompt-accepted',
          commandId,
          walnutMessageId: attempt.intent.walnutMessageId,
          text: attempt.intent.text,
        })
        repaired = true
      }
      if (!attempt.terminal) {
        this.journal.appendMeta({
          type: 'turn-interrupted',
          reason: attempt.dispatched ? 'worker-crash' : 'dispatch-indeterminate',
          commandId,
        })
        repaired = true
      }
    }
    if (repaired) this.notifyJournal()
  }

  private commandKey(op: string, commandId: string): string {
    return `${op}\0${commandId}`
  }

  private frameSource(): AcpFrameSource {
    if (this.loadingSession) return 'provider-replay'
    if (this.controlPrompt) return 'control'
    if (this.turnActive) return 'live'
    // Gap between prompts: a provider may resolve the prompt RPC before its
    // final agent_message_chunks are dispatched here (opencode), so a straggler
    // right after a USER turn is that turn's reply — dropping it as 'control'
    // ate the visible answer. A straggler after a CONTROL prompt (title
    // generation) stays control, or the title text would leak into the chat.
    return this.lastEnded === 'turn' ? 'live' : 'control'
  }

  // ── Helpers ──

  private requireConn(): ClientSideConnection {
    if (!this.conn) throw <WorkerError>{ kind: 'protocol', message: 'not initialized — call initialize first' }
    return this.conn
  }

  private notifyJournal(): void { this.onJournalAppend(this.journal.offset) }
  private ok(req: WorkerRequest, result: unknown): WorkerResponse { return { id: req.id, ok: true, result } }
  private err(req: WorkerRequest, error: WorkerError): WorkerResponse { return { id: req.id, ok: false, error } }
}

/** Resumes of a direct Codex thread that failed in a row with the same reason before it gives up on it. */
const RESUME_GIVE_UP = 3

/**
 * How many of the latest resumes of `threadId` failed in a row with these words: the run
 * at the end only (another reason, a load or a start in between ends a run).
 */
function resumeErrorsInARow(journalPath: string, threadId: string, words: string): number {
  let run = 0
  let reason: string | undefined
  try {
    for (const { record } of readJournal(journalPath).records) {
      if (record.kind !== 'meta') continue
      const event = record.event
      if (event.type === 'resume-error' && event.providerSessionId === threadId) {
        run = event.reason === reason ? run + 1 : 1
        reason = event.reason
      } else if (event.type === 'session-loaded' || event.type === 'session-created' || event.type === 'resume-failed') {
        run = 0
        reason = undefined
      }
    }
  } catch { /* unreadable: count from here */ }
  return reason === words ? run : 0
}

/** True when the ON-DISK journal holds conversation evidence (a session
 *  created/loaded or an accepted prompt) — the precondition for dropping a
 *  resume's replay burst. Re-reads the file rather than trusting in-memory
 *  state; see the call site in opLoadSession. */
function journalHoldsConversation(journalPath: string): boolean {
  try {
    for (const { record } of readJournal(journalPath).records) {
      if (record.kind !== 'meta') continue
      const t = record.event.type
      if (t === 'session-created' || t === 'session-loaded' || t === 'prompt-accepted') return true
    }
  } catch { /* unreadable = no evidence */ }
  return false
}

function isWorkerError(e: unknown): e is WorkerError {
  return typeof e === 'object' && e !== null && 'kind' in e && 'message' in e && !(e instanceof Error)
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export interface ProviderErrorReport { op: string; kind: WorkerError['kind']; detail: string }

const PROVIDER_DETAIL_MAX = 500

/**
 * What the provider said about a failure, for the daemon's log only. The journal
 * (shown in chat, mirrored off the machine) keeps the category alone, but with
 * only the category nobody could tell why a session broke: on 2026-10-30 Codex
 * answered "This chat uses local-proxy, but your current provider is
 * hosted-provider" for every resume and turn, and every log said "ACP provider
 * protocol operation failed". Redacted (src/logging/redact.ts), one line, capped.
 */
export function providerErrorDetail(error: unknown): string | undefined {
  const record = asObject(error)
  const data = asObject(record.data)
  const pick = [data.details, data.message, error instanceof Error ? error.message : record.message]
    .find((v): v is string => typeof v === 'string' && v.trim() !== '' && v.trim() !== 'Internal error')
  if (!pick) return undefined
  const line = redactSensitiveText(pick).replace(/\s+/g, ' ').trim()
  return line.length > PROVIDER_DETAIL_MAX ? line.slice(0, PROVIDER_DETAIL_MAX) + '…' : line
}

function sanitizeWorkerError(error: WorkerError, provider?: unknown): WorkerError {
  // Walnut's own words (a direct Codex start: a version, a missing binary, a thread it cannot resume) name no secret.
  const message = error.walnutWords ? error.message
    : error.kind === 'provider_incompatible' && provider === 'pi'
    ? 'Pi 0.80.4 or newer is required; update the Pi CLI.'
    : safeWorkerErrorMessage(error.kind)
  return { kind: error.kind, message }
}

const AUTH_REJECTION_RE = /\b(?:(?:no|missing|invalid|expired) (?:api[ -]?key|credentials?)|unauthori[sz]ed|unauthenticated|not (?:signed|logged) in|authentication (?:required|failed)|auth required|login required|401)\b/i

export function classifyPromptRejection(error: unknown): Extract<WorkerError['kind'], 'auth_required' | 'protocol' | 'usage_limit'> {
  const record = asObject(error)
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : record.message
  // codex-acp rejects a turn its usage limit refused with the provider's error in `data`
  // ({message, codexErrorInfo: 'usageLimitExceeded'}).
  const data = asObject(record.data)
  if (data.codexErrorInfo === 'usageLimitExceeded' || matchesUsageLimitText(rejectionText(error))) return 'usage_limit'
  return record.code === -32000 || (typeof text === 'string' && AUTH_REJECTION_RE.test(text))
    ? 'auth_required'
    : 'protocol'
}

/** The provider's own words on a rejected prompt (its message, and the adapter's `data.message`). */
function rejectionText(error: unknown): string {
  const record = asObject(error)
  const data = asObject(record.data)
  const parts = [error instanceof Error ? error.message : typeof error === 'string' ? error : record.message, data.message, data.additionalDetails]
  return parts.filter((p): p is string => typeof p === 'string').join(' \n')
}

/** A direct Codex turn's failure kind, from Codex's own error code first (codex-app-server/errors.ts). */
export function classifyDirectRejection(error: unknown): WorkerError['kind'] {
  if (error instanceof AppServerRpcError) {
    if (error.exited) return 'app_server_exited'
    if (error.timedOut) return 'turn_stalled'
  }
  if (matchesUsageLimitText(rejectionText(error))) return 'usage_limit'
  return classifyCodexFailure(asObject(error).data) ?? classifyPromptRejection(error)
}

function safeWorkerErrorMessage(kind: WorkerError['kind']): string {
  switch (kind) {
    case 'adapter_spawn_failed': return 'ACP adapter could not be started'
    case 'provider_missing': return 'ACP provider executable is unavailable'
    case 'provider_incompatible': return 'ACP provider version is incompatible'
    case 'auth_required': return 'ACP provider authentication is required'
    case 'load_failed': return 'ACP provider session could not be loaded'
    case 'no_session': return 'ACP provider session is not established'
    case 'turn_active': return 'ACP provider turn is already active'
    case 'no_turn': return 'ACP provider has no live turn to steer'
    case 'steer_unsupported': return 'ACP adapter does not support mid-turn steering'
    case 'steer_race': return 'ACP live turn ended before steering applied'
    case 'protocol': return 'ACP provider protocol operation failed'
    case 'usage_limit': return 'Usage limit reached'
    case 'rate_limited': return 'Codex rate limit reached (429); the turn can be tried again shortly'
    case 'overloaded': return 'Codex model service is overloaded (503); the turn can be tried again'
    case 'server_error': return 'Codex model service failed (internal server error); the turn can be tried again'
    case 'connection': return 'Codex lost the connection to the model service (connection error)'
    case 'context_window': return 'Codex context window exceeded: the conversation is too long for the model'
    case 'app_server_exited': return 'Codex app-server stopped unexpectedly (connection closed); the next message starts it again'
    case 'turn_stalled': return 'Codex sent nothing for too long, so Walnut stopped the turn (operation timed out)'
    case 'internal': return 'ACP worker operation failed'
  }
}

// ── Process entry (daemon child mode) ──
// Invoked as: node worker.js --journal <path>
// stdin/stdout = NDJSON JSON-RPC with the daemon; stderr = diagnostics.

export function runWorkerMain(): void {
  const journalArg = process.argv.indexOf('--journal')
  const journalPath = journalArg >= 0 ? process.argv[journalArg + 1] : null
  if (!journalPath) {
    process.stderr.write('acp-worker: missing --journal <path>\n')
    process.exit(2)
  }

  const writeLine = (obj: unknown): void => { process.stdout.write(JSON.stringify(obj) + '\n') }
  const worker = new AcpWorker(
    journalPath,
    (offset) => writeLine({ ev: 'journal', offset }),
    (bytes) => writeLine({ ev: 'adapter_stderr', bytes }),
    // Exit once stdout has drained, so the lines already written reach the daemon.
    () => { process.stdout.write('', () => process.exit(3)) },
    (report) => writeLine({ ev: 'provider_error', ...report }),
  )

  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let req: WorkerRequest
    try { req = JSON.parse(line) as WorkerRequest } catch {
      writeLine({ id: -1, ok: false, error: { kind: 'protocol', message: 'unparseable request line' } })
      return
    }
    void worker.handle(req).then(writeLine).then(() => {
      if (req.op === 'shutdown') process.exit(0)
    })
  })
  // Daemon death closes our stdin → exit; our death closes adapter stdin → chain teardown.
  rl.on('close', () => { void worker.handle({ id: -1, op: 'shutdown' }).finally(() => process.exit(0)) })
}
