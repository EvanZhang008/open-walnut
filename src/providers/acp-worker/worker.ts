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
import type {
  AcpMcpServer,
  WorkerRequest,
  WorkerResponse,
  WorkerError,
  InitializeParams,
  NewSessionParams,
  LoadSessionParams,
  PromptParams,
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

export class AcpWorker {
  private journal: AcpJournal
  private adapter: ChildProcess | null = null
  private conn: ClientSideConnection | null = null
  private providerSessionId: string | null = null
  private cwd = ''
  private turnActive = false
  private turnCommandId: string | null = null
  private controlPrompt: { commandId: string; purpose: 'self-report' } | null = null
  private loadingSession = false
  /** providerRequestId → live JSON-RPC resolver. Dies with the process (by design). */
  private pendingPermissions = new Map<string, PendingPermission>()
  private permissionSeq = 0
  /** op+commandId → original result, rebuilt from the journal on every worker start. */
  private acceptedCommands = new Map<string, { op: string; commandId: string; result: unknown }>()
  private lastAcceptedCommands = new Map<string, string>()
  private onJournalAppend: (offset: number) => void
  private onAdapterStderr: (bytes: number) => void

  constructor(
    journalPath: string,
    onJournalAppend: (offset: number) => void = () => {},
    onAdapterStderr: (bytes: number) => void = () => {},
  ) {
    this.journal = new AcpJournal(journalPath)
    this.onJournalAppend = onJournalAppend
    this.onAdapterStderr = onAdapterStderr
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
        case 'cancel':            return this.ok(req, await this.opCancel(req.params as unknown as CancelParams))
        case 'permissionResponse':return this.ok(req, this.opPermissionResponse(req.params as unknown as PermissionResponseParams))
        case 'setConfigOption':    return this.ok(req, await this.opSetConfigOption(req.params as unknown as SetConfigOptionParams))
        case 'getState':          return this.ok(req, this.opGetState())
        case 'shutdown':          return this.ok(req, await this.opShutdown())
        default:
          return this.err(req, { kind: 'protocol', message: `unknown op: ${(req as WorkerRequest).op}` })
      }
    } catch (e) {
      const werr: WorkerError = isWorkerError(e) ? e : { kind: 'internal', message: e instanceof Error ? e.message : String(e) }
      const safeError = sanitizeWorkerError(werr)
      const control = req.op === 'prompt'
        && (req.params as Partial<PromptParams> | undefined)?.control === 'self-report'
      const recoverableLoadFailure = req.op === 'loadSession' && werr.kind === 'load_failed'
      if (recoverableLoadFailure) {
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
      if (!recoverableLoadFailure) this.notifyJournal()
      return this.err(req, safeError)
    }
  }

  private async opInitialize(params: InitializeParams): Promise<unknown> {
    if (this.conn) return { alreadyInitialized: true }
    this.cwd = params.cwd

    const [cmd, ...cmdArgs] = params.adapterCommand ?? []
    if (!cmd) throw <WorkerError>{ kind: 'adapter_spawn_failed', message: 'empty adapterCommand' }
    const adapter = spawn(cmd, cmdArgs, {
      cwd: params.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...params.env },
    })
    await new Promise<void>((resolve, reject) => {
      adapter.once('spawn', resolve)
      adapter.once('error', (e) => reject(<WorkerError>{ kind: 'adapter_spawn_failed', message: e.message }))
    })
    this.adapter = adapter
    adapter.on('exit', (code) => {
      // Adapter death mid-turn = the turn is gone (no hot reattach exists).
      if (this.turnActive) {
        const commandId = this.turnCommandId ?? undefined
        this.turnActive = false
        this.turnCommandId = null
        this.journal.appendMeta({ type: 'turn-interrupted', reason: 'worker-crash', commandId })
        this.notifyJournal()
      }
      if (this.controlPrompt) {
        this.finishControlPrompt(this.controlPrompt.commandId, 'worker-crash', 'ACP adapter exited')
      }
      this.failAllPendingPermissions()
      void code
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
    this.loadingSession = true
    try {
      const resp = await conn.loadSession({
        sessionId: params.providerSessionId,
        cwd: params.cwd || this.cwd,
        mcpServers: this.mcpServersFor(params),
      })
      this.providerSessionId = params.providerSessionId
      this.sessionResponse = resp
      this.models = snapshotAcpModels(resp)
      this.configOptions = snapshotAcpConfigOptions(resp)
      this.journal.appendMeta({ type: 'session-loaded', providerSessionId: params.providerSessionId })
      this.notifyJournal()
      return resp
    } catch (e) {
      throw <WorkerError>{ kind: 'load_failed', message: e instanceof Error ? e.message : String(e) }
    } finally {
      this.loadingSession = false
    }
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
      this.journal.appendMeta({ type: 'turn-ended', commandId: params.commandId, stopReason: resp.stopReason })
      this.notifyJournal()
    }).catch((e) => {
      if (this.turnCommandId !== params.commandId) return
      this.turnActive = false
      this.turnCommandId = null
      this.journal.appendMeta({
        type: 'error',
        errorKind: 'protocol',
        message: safeWorkerErrorMessage('protocol'),
        commandId: params.commandId,
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
      this.finishControlPrompt(params.commandId, resp.stopReason)
    }).catch((error) => {
      this.finishControlPrompt(
        params.commandId,
        'error',
        safeWorkerErrorMessage('protocol'),
      )
      void error
    })
    return acceptedResult
  }

  private finishControlPrompt(commandId: string, stopReason: string, error?: string): void {
    if (this.controlPrompt?.commandId !== commandId) return
    this.controlPrompt = null
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
    const accepted = {
      applied: true,
      configId: params.configId,
      value: params.value,
    }
    this.rememberAcceptedCommand('setConfigOption', params.commandId, accepted)
    this.sessionResponse = {
      ...asObject(this.sessionResponse),
      configOptions: resp.configOptions,
    }
    const responseOptions = snapshotAcpConfigOptions(resp)
    this.configOptions = (responseOptions.length > 0 ? responseOptions : this.configOptions)
      .map((option) => option.id === params.configId && typeof params.value === 'string'
        ? { ...option, currentValue: params.value }
        : option)
    if (params.configId === 'model' && typeof params.value === 'string') {
      this.models = { ...this.models, currentModelId: params.value }
    }
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
      adapterPid: this.adapter?.pid ?? null,
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
        // Raw to journal; zero interpretation here.
        this.journal.appendAcpFrame(
          { method: 'session/update', params },
          this.frameSource(),
        )
        this.notifyJournal()
      },
      requestPermission: (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        const providerRequestId = `perm-${++this.permissionSeq}`
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
              toolCall: params.toolCall,
              options: params.options,
              receivedAt: Date.now(),
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
    return this.turnActive ? 'live' : 'control'
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

function isWorkerError(e: unknown): e is WorkerError {
  return typeof e === 'object' && e !== null && 'kind' in e && 'message' in e && !(e instanceof Error)
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function sanitizeWorkerError(error: WorkerError): WorkerError {
  return { kind: error.kind, message: safeWorkerErrorMessage(error.kind) }
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
    case 'protocol': return 'ACP provider protocol operation failed'
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
