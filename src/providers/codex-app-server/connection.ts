/**
 * Walnut's own client for `codex app-server`, in the ACP worker's place of the
 * codex-acp adapter (docs/reference/codex-engine.md, "How it reaches Codex").
 *
 * It offers the worker the calls the worker made on the adapter's ACP connection
 * (initialize, newSession, loadSession, prompt, steering, cancel, config options)
 * and calls back the same two client methods (sessionUpdate, requestPermission)
 * with ACP-shaped frames, so the journal, the projector, the web and the phone
 * read a direct session exactly as before. What it does that the adapter could not:
 * - a steer goes to `turn/steer` with the live turn's id and NEVER starts a turn
 *   of its own: a text that missed the turn comes back `noActiveTurn`, and Walnut's
 *   queue sends it as the next prompt with the same message id;
 * - a stop is `turn/interrupt`, and the turn's own end answers it, so the worker
 *   (and its app-server) live on and the next message needs no cold start;
 * - a resume is `thread/resume` by thread id, without the history replay;
 * - every request has a deadline, a turn that goes quiet is stopped by a watchdog,
 *   and the process's exit is seen at once;
 * - a steer Codex took but did not answer before its turn ended is answered in a
 *   follow-up Codex turn of the same Walnut turn (turn.ts);
 * - plan mode, its "Implement this plan?" question, and the adapter's slash commands
 *   (commands.ts) work as they did there;
 * - a command the turn left running is reported at the turn's end and when it ends
 *   (background.ts), so Walnut reads the task as working and wakes it then.
 */

import { randomUUID } from 'node:crypto'
import type { CodexLaunch } from './launch.js'
import { AppServerRpc, AppServerRpcError, type AppServerExit } from './rpc.js'
import { CodexSessionControls, initialAgentMode } from './controls.js'
import { CodexEventMapper, type AcpUpdate } from './events.js'
import { CodexApprovals, type AcpPermissionRequest, type AcpPermissionResponse } from './approvals.js'
import { LiveTurn, type TurnResult } from './turn.js'
import { CodexBackgroundWork, backgroundPollMs, listedTerminals, type BackgroundTerminal, type BackgroundWorkState } from './background.js'
import { buildThreadConfig, turnUsage, withTimeout } from './thread-config.js'
import { commandAnswer, parseSlashCommand, planCommand, type CommandStart } from './commands.js'
import type { CodexModelRow } from '../codex-model-probe.js'
import type { AcpMcpServer } from '../acp-worker/protocol.js'

const INIT_TIMEOUT_MS = 30_000
const THREAD_TIMEOUT_MS = 120_000
const TURN_START_TIMEOUT_MS = 60_000
const INTERRUPT_TIMEOUT_MS = 10_000
const MODEL_LIST_TIMEOUT_MS = 20_000
const MAX_MODEL_PAGES = 50
const WATCHDOG_TICK_MS = 15_000
const STEER_SETTLE_MS = 1_500
/** Follow-up Codex turns one Walnut turn may run for steers Codex left unanswered. */
const MAX_CONTINUATIONS = 2
const IMPLEMENT_PLAN_TEXT = 'Implement the approved plan.'
/** All of a stop's background-terminal clean-up, so the stop answers well inside the daemon's wait. */
const TERMINATE_BUDGET_MS = 3_000
/** Reading what runs on at a turn's end: the turn's end waits on it. */
const BACKGROUND_LIST_TIMEOUT_MS = 5_000

/** No event at all for this long while a turn runs and nothing is in progress: the turn is stuck. */
export function stallIdleMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.WALNUT_CODEX_STALL_MS)
  return Number.isFinite(n) && n > 0 ? n : 15 * 60_000
}
/** How long a turn/steer may go unanswered (a test shortens it). */
function steerTimeoutMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.WALNUT_CODEX_STEER_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : 30_000
}
/** The same while a command or tool call runs (a quiet build or test run is no stall). */
export function stallItemMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.WALNUT_CODEX_STALL_ITEM_MS)
  return Number.isFinite(n) && n > 0 ? n : 90 * 60_000
}

export interface AcpClientHandler {
  sessionUpdate(params: { sessionId: string; update: AcpUpdate }): void
  requestPermission(params: AcpPermissionRequest): Promise<AcpPermissionResponse>
}

export interface CodexConnectionHooks {
  /** The app-server process ended while it was not being closed. */
  onExit(exit: AppServerExit): void
  onStderr(bytes: number): void
  /** What of the session's own commands runs on after its turn, and which of them ended (background.ts). */
  onBackgroundWork?(state: BackgroundWorkState): void
}

/** A turn's failure, shaped as the adapter rejected a prompt (worker.ts classifyPromptRejection reads `data`). */
export class CodexTurnError extends Error {
  constructor(message: string, readonly data: Record<string, unknown>) {
    super(message)
    this.name = 'CodexTurnError'
  }
}


const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** A turn's own input, with the client id Codex reports it back under. */
type InputStart = { kind: 'input'; text: string; clientId: string }

const newClientId = () => `walnut-${randomUUID()}`

export class CodexDirectConnection {
  private rpc: AppServerRpc
  private threadId: string | null = null
  private turn: LiveTurn | null = null
  /** turn/completed of a turn Walnut already settled, awaited by id (the stall's interrupt). */
  private readonly endWaiters = new Map<string, () => void>()
  /** That interrupt, while it runs: the next turn waits for it. */
  private stallCleanup: Promise<void> | null = null
  private closing = false
  private watchdog: ReturnType<typeof setInterval> | null = null
  private readonly controls: CodexSessionControls
  private readonly events: CodexEventMapper
  private readonly approvals: CodexApprovals
  private readonly background: CodexBackgroundWork
  /** Turns that ended here: a late event of one is never taken for the next turn's. */
  private readonly endedTurnIds = new Set<string>()
  private rowsLoaded = false
  /** The last token use Codex reported, for /status. */
  private lastUsage: { usage?: Record<string, number>; window?: number } = {}
  private commandSeq = 0

  constructor(
    private readonly launch: CodexLaunch,
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly client: AcpClientHandler,
    private readonly hooks: CodexConnectionHooks,
  ) {
    this.controls = new CodexSessionControls(initialAgentMode(env))
    this.events = new CodexEventMapper((update) => this.emit(update))
    this.approvals = new CodexApprovals((req) => this.client.requestPermission(req), () => this.threadId ?? '', this.events, (update) => this.emit(update))
    this.background = new CodexBackgroundWork({
      list: () => this.listBackgroundTerminals(BACKGROUND_LIST_TIMEOUT_MS),
      turnRunning: () => this.turn !== null,
      report: (state) => hooks.onBackgroundWork?.(state),
      pollMs: backgroundPollMs(env),
    })
    this.rpc = new AppServerRpc({
      command: launch.command,
      args: launch.args,
      shell: launch.shell,
      cwd,
      env,
      onNotification: (method, params) => this.onNotification(method, params),
      onServerRequest: (method, params) => {
        this.touch()
        return this.approvals.answer(method, params)
      },
      onExit: (exit) => this.onExit(exit),
      onStderr: (bytes) => hooks.onStderr(bytes),
    })
  }

  get pid(): number | undefined { return this.rpc.pid }
  get version(): string { return this.launch.version }

  async initialize(): Promise<Record<string, unknown>> {
    await this.rpc.start()
    await this.rpc.request('initialize', {
      clientInfo: { name: 'open-walnut', title: 'Walnut', version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, INIT_TIMEOUT_MS)
    this.rpc.notify('initialized')
    // A short stall limit (tests) is checked as often as it needs.
    const tick = Math.max(50, Math.min(WATCHDOG_TICK_MS, Math.floor(stallIdleMs(this.env) / 4)))
    this.watchdog = setInterval(() => this.checkStall(), tick)
    this.watchdog.unref?.()
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: {},
      },
      agentInfo: { name: 'codex-app-server', version: this.launch.version },
      authMethods: [],
      _meta: {
        // Walnut's queue sends a text that missed the live turn as the next prompt: never a turn of our own.
        steering: { supported: true, injectOnly: true },
        walnut: { transport: 'codex-app-server', codexVersion: this.launch.version, gracefulCancel: true },
      },
    }
  }

  async newSession(params: { cwd?: string; mcpServers?: AcpMcpServer[] }): Promise<Record<string, unknown>> {
    await this.loadModelRows()
    const cwd = params.cwd || this.cwd
    const config = await this.threadConfig(cwd, params.mcpServers)
    // As the adapter started threads: the model, instructions and provider ride `config`;
    // the approval and sandbox policy ride each turn (CodexSessionControls.turnParams).
    const provider = this.modelProvider()
    const resp = await this.rpc.request<Record<string, unknown>>('thread/start', {
      config, cwd, ...(provider ? { modelProvider: provider } : {}),
    }, THREAD_TIMEOUT_MS)
    return this.adoptThread(resp)
  }

  /** `replay`: send the thread's past turns as provider-replay frames (the journal lost them). */
  async loadSession(params: { sessionId: string; cwd?: string; mcpServers?: AcpMcpServer[]; replay?: boolean }): Promise<Record<string, unknown>> {
    await this.loadModelRows()
    const cwd = params.cwd || this.cwd
    const config = await this.threadConfig(cwd, params.mcpServers)
    const provider = this.modelProvider()
    // excludeTurns (experimental on the oldest supported Codex, which our initialize opts into):
    // the thread's past turns stay in Codex, unread, unless the journal lost them.
    const excludeTurns = !params.replay
    const resp = await this.rpc.request<Record<string, unknown>>('thread/resume', {
      threadId: params.sessionId, config, cwd, ...(provider ? { modelProvider: provider } : {}),
      ...(excludeTurns ? { excludeTurns: true } : {}),
    }, THREAD_TIMEOUT_MS)
    const out = this.adoptThread(resp)
    if (params.replay) {
      const turns = isRecord(resp.thread) && Array.isArray(resp.thread.turns) ? resp.thread.turns : []
      this.events.replayTurns(turns)
    }
    return out
  }

  /** Resolves at the turn's end; rejects with CodexTurnError when it failed. */
  async prompt(params: { sessionId: string; prompt: Array<{ type: string; text?: string }> }): Promise<TurnResult> {
    if (this.turn) throw new Error('a Codex turn is already running')
    // A stalled turn Walnut ended may still run at Codex: wait until Codex ends it (or its
    // process goes), so this message never meets "a turn is already running".
    if (this.stallCleanup) await this.stallCleanup
    if (this.turn) throw new Error('a Codex turn is already running')
    this.requireThread()
    const text = params.prompt.map((b) => b.text ?? '').join('')
    const command = parseSlashCommand(text)
    const plan = command ? planCommand(command) : undefined
    if (plan && plan.kind !== 'turn') {
      const text = await commandAnswer(plan, {
        controls: this.controls, rpc: this.rpc, cwd: this.cwd, codexVersion: this.launch.version,
        threadId: this.threadId ?? undefined, lastUsage: this.lastUsage,
        emit: (update) => this.emit(update),
      })
      this.emit({ sessionUpdate: 'agent_message_chunk', messageId: `codex-command:${++this.commandSeq}`, content: { type: 'text', text } })
      return { stopReason: 'end_turn' }
    }
    const start: CommandStart | InputStart = plan?.kind === 'turn' ? plan.start : { kind: 'input', text, clientId: newClientId() }
    // A compaction reports no input of its own; a turn and a review report theirs.
    const turn = new LiveTurn(start.kind === 'compact' ? [] : start.kind === 'review' ? [null] : [{ text: start.text, clientId: start.clientId }])
    this.turn = turn
    this.events.beginTurn()
    await this.startCodexTurn(turn, start)
    return turn.done
  }

  /** Start (or go on with) a Codex turn for `turn`. A failure to start ends the turn. */
  private async startCodexTurn(turn: LiveTurn, start: CommandStart | InputStart): Promise<void> {
    // A late answer to an earlier start of this turn must not touch a follow-up's identity.
    const generation = turn.continuations
    const current = () => !turn.settled && turn.continuations === generation
    try {
      const threadId = this.requireThread()
      const resp: Record<string, unknown> = start.kind === 'compact'
        ? await this.rpc.request('thread/compact/start', { threadId }, TURN_START_TIMEOUT_MS)
        : start.kind === 'review'
          ? await this.rpc.request('review/start', { threadId, target: start.target, delivery: 'inline' }, TURN_START_TIMEOUT_MS)
          : await this.rpc.request('turn/start', {
            threadId,
            clientUserMessageId: start.clientId,
            input: [{ type: 'text', text: start.text, text_elements: [] }],
            ...this.controls.turnParams(),
          }, TURN_START_TIMEOUT_MS)
      const id = isRecord(resp.turn) && typeof resp.turn.id === 'string' ? resp.turn.id : undefined
      if (!current()) { if (id) this.retireTurnId(id); return }
      // Codex's answer names the turn; it wins over an id read from an event.
      if (id) turn.adoptId(id)
      // A compaction's answer names no turn: its turn/started does.
      if (turn.id || start.kind !== 'compact') turn.markStarted(turn.id)
    } catch (error) {
      if (!current()) return
      turn.markStarted(undefined)
      this.settleTurn(turn, { error: error instanceof Error ? error : new Error(String(error)) })
    }
  }

  /** The same Walnut turn goes on as a new Codex turn. */
  private continueTurn(turn: LiveTurn, text: string): void {
    const clientId = newClientId()
    for (const id of turn.continueAs([{ text, clientId }])) this.retireTurnId(id)
    this.events.endTurn()
    this.events.beginTurn()
    void this.startCodexTurn(turn, { kind: 'input', text, clientId })
  }

  /** `_session/steering`: inject into the LIVE turn only (see the file comment). */
  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method !== '_session/steering') throw new Error(`unknown extension method: ${method}`)
    const turn = this.turn
    // A turn waiting on the plan question runs nothing at Codex, and a turn being stopped takes
    // nothing more: the words go in the next turn.
    if (!turn || turn.settled || turn.holding || turn.stopping || turn.ending) return { outcome: 'noActiveTurn' }
    const turnId = turn.id ?? await withTimeout(turn.started, TURN_START_TIMEOUT_MS)
    if (!turnId || turn.settled || this.turn !== turn) return { outcome: 'noActiveTurn' }
    const prompt = Array.isArray(params.prompt) ? params.prompt as Array<{ text?: string }> : []
    const text = prompt.map((b) => b.text ?? '').join('')
    // Codex reports a steer it took as a userMessage item of the turn, carrying the client id
    // sent with it. That, not the answer, is the proof: an answer lost or late (timed out) can
    // belong to a steer Codex did take, and the same words can be another input's. A Codex that
    // reports no client id is read by the words of its id-less reports.
    const clientId = newClientId()
    const unidentifiedBefore = turn.unidentifiedTexts.filter((t) => t === text).length
    const taken = () => turn.reportedIds.has(clientId) || turn.unidentifiedTexts.filter((t) => t === text).length > unidentifiedBefore
    // Taken as soon as Codex reports it: the caller records the person's line right then
    // (`onTaken`, synchronously), ahead of anything Codex sends after the report.
    const onTaken = typeof params.onTaken === 'function' ? params.onTaken as () => void : undefined
    const report = turn.whenUserText(taken, onTaken)
    try {
      const answer = this.rpc.request('turn/steer', {
        threadId: this.requireThread(),
        clientUserMessageId: clientId,
        input: [{ type: 'text', text, text_elements: [] }],
        expectedTurnId: turnId,
      }, steerTimeoutMs(this.env))
      answer.catch(() => {})
      await Promise.race([answer, report.seen])
      this.touch()
      return { outcome: 'injected' }
    } catch (error) {
      if (taken()) return { outcome: 'injected' }
      // The turn ended between our check and Codex's (its id no longer matches, or none runs).
      // Its turn/completed may still be on the way: our own state decides, after a short wait.
      await withTimeout(turn.ended, STEER_SETTLE_MS)
      if (taken()) return { outcome: 'injected' }
      if (!this.turn || this.turn !== turn || turn.settled) return { outcome: 'noActiveTurn' }
      const data = error instanceof AppServerRpcError ? error.data : undefined
      if (isRecord(data) && isRecord(data.codexErrorInfo) && 'activeTurnNotSteerable' in data.codexErrorInfo) return { outcome: 'failed' }
      const words = error instanceof Error ? error.message : ''
      if (/no active turn to steer/i.test(words)) return { outcome: 'noActiveTurn' }
      return { outcome: 'failed' }
    } finally {
      report.dispose()
    }
  }

  /**
   * Stop the running turn with turn/interrupt and wait for its end. `turnClosed`
   * false: Codex did not end it in time, and the caller tears the process down.
   */
  async cancel(_params: { sessionId: string }): Promise<{ turnClosed: boolean }> {
    const turn = this.turn
    // No turn runs, but commands the last one left running do: a stop ends them.
    if (!turn || turn.settled) {
      if (this.background.count > 0) await this.stopBackground()
      return { turnClosed: true }
    }
    turn.stopping = true
    // Waiting on the person's plan answer: no Codex turn runs. The question is withdrawn and
    // its card closed (askToImplement) before the turn ends.
    if (turn.holding) {
      this.approvals.cancelAll()
      await withTimeout(turn.ended, STEER_SETTLE_MS)
      this.endTurn(turn, { stopReason: 'cancelled' }, true)
      await withTimeout(turn.ended, STEER_SETTLE_MS)
      await this.stopBackground()
      return { turnClosed: true }
    }
    const deadline = Date.now() + INTERRUPT_TIMEOUT_MS
    const turnId = turn.id ?? await withTimeout(turn.started, INTERRUPT_TIMEOUT_MS)
    if (turn.settled) return { turnClosed: true }
    if (!turnId) return { turnClosed: false }
    try {
      await this.rpc.request('turn/interrupt', { threadId: this.requireThread(), turnId }, Math.max(1, deadline - Date.now()))
    } catch {
      // Refused because the turn just ended: its turn/completed may still be on the way.
      await withTimeout(turn.ended, STEER_SETTLE_MS)
      if (!turn.settled) return { turnClosed: false }
    }
    const ended = await withTimeout(turn.ended, Math.max(1, deadline - Date.now()))
    // An interrupt leaves Codex's background terminals running; a stop ends them too.
    await this.stopBackground()
    return { turnClosed: ended === true || turn.settled }
  }

  /**
   * A stop ends the thread's background terminals within TERMINATE_BUDGET_MS overall (the
   * daemon's stop waits on it; best effort, an older Codex has no such call). They are
   * dropped first, so the end of one is never taken for news that wakes the session.
   */
  private async stopBackground(): Promise<void> {
    this.background.dropAll()
    const threadId = this.threadId
    if (!threadId) return
    const deadline = Date.now() + TERMINATE_BUDGET_MS
    const left = () => Math.max(1, deadline - Date.now())
    const listed = await this.listBackgroundTerminals(left())
    if (!listed) return
    await withTimeout(Promise.all(listed.map(({ processId }) =>
      this.rpc.request('thread/backgroundTerminals/terminate', { threadId, processId }, left()).catch(() => {}))), left())
  }

  /** The thread's background terminals; null when this Codex cannot say. */
  private async listBackgroundTerminals(timeoutMs: number): Promise<BackgroundTerminal[] | null> {
    const threadId = this.threadId
    if (!threadId) return null
    try {
      return listedTerminals(await this.rpc.request('thread/backgroundTerminals/list', { threadId }, timeoutMs))
    } catch {
      return null
    }
  }

  async setSessionConfigOption(params: { configId: string; value: string | boolean }): Promise<Record<string, unknown>> {
    if (typeof params.value !== 'string') throw new Error(`${params.configId} takes a string value`)
    this.controls.set(params.configId, params.value)
    return { configOptions: this.controls.sessionState().configOptions }
  }

  async close(): Promise<void> {
    this.closing = true
    if (this.watchdog) clearInterval(this.watchdog)
    this.background.close()
    await this.rpc.close()
  }

  kill(): void {
    this.closing = true
    if (this.watchdog) clearInterval(this.watchdog)
    this.background.close()
    this.rpc.kill()
  }

  // ── internals ──

  private requireThread(): string {
    if (!this.threadId) throw new Error('no Codex thread: start or resume one first')
    return this.threadId
  }

  private async threadConfig(cwd: string, mcpServers: AcpMcpServer[] | undefined): Promise<Record<string, unknown>> {
    const { config, workspaceWrite } = await buildThreadConfig(this.rpc, this.launch.threadConfig, this.env, cwd, mcpServers)
    // The host's [sandbox_workspace_write] (writable roots, network) stays under the Agent mode's sandbox.
    this.controls.adoptWorkspaceWrite(workspaceWrite)
    return config
  }

  /**
   * The provider a thread runs on when Walnut was told one: the one CODEX_CONFIG names
   * (engines.codex.provider, or the user's own CODEX_CONFIG), else MODEL_PROVIDER. With
   * neither, none is named and Codex uses the host's own config, as the codex CLI does.
   */
  private modelProvider(): string | undefined {
    if (typeof this.launch.threadConfig.model_provider === 'string') return this.launch.threadConfig.model_provider
    return this.env.MODEL_PROVIDER || undefined
  }

  private adoptThread(resp: Record<string, unknown>): Record<string, unknown> {
    const thread = isRecord(resp.thread) ? resp.thread : {}
    if (typeof thread.id !== 'string' || !thread.id) throw new Error('codex app-server answered without a thread id')
    this.threadId = thread.id
    this.controls.adoptThread(
      typeof resp.model === 'string' ? resp.model : undefined,
      typeof resp.reasoningEffort === 'string' ? resp.reasoningEffort : undefined,
    )
    return { sessionId: thread.id, ...this.controls.sessionState() }
  }

  private async loadModelRows(): Promise<void> {
    if (this.rowsLoaded) return
    this.rowsLoaded = true
    const rows: CodexModelRow[] = []
    let cursor: string | null = null
    try {
      for (let page = 0; page < MAX_MODEL_PAGES; page++) {
        const resp: Record<string, unknown> = await this.rpc.request('model/list', { cursor, limit: null }, MODEL_LIST_TIMEOUT_MS)
        for (const row of Array.isArray(resp.data) ? resp.data : []) {
          if (isRecord(row) && typeof row.id === 'string' && Array.isArray(row.supportedReasoningEfforts)) rows.push(row as unknown as CodexModelRow)
        }
        cursor = typeof resp.nextCursor === 'string' && resp.nextCursor ? resp.nextCursor : null
        if (!cursor) break
      }
    } catch { /* the menu is empty; the session itself still runs */ }
    this.controls.rows = rows
  }

  private emit(update: AcpUpdate): void {
    if (!this.threadId) return
    this.client.sessionUpdate({ sessionId: this.threadId, update })
  }

  private touch(): void {
    if (this.turn) this.turn.lastEventAt = Date.now()
  }

  private onNotification(method: string, params: unknown): void {
    if (!isRecord(params)) return
    // Another thread's events (a subagent's) are not this session's transcript.
    if (typeof params.threadId === 'string' && this.threadId && params.threadId !== this.threadId) return
    const turn = this.turn
    const turnId = typeof params.turnId === 'string' ? params.turnId
      : isRecord(params.turn) && typeof params.turn.id === 'string' ? params.turn.id : undefined
    const stale = turnId !== undefined && this.endedTurnIds.has(turnId)
    if (turn && method === 'turn/started' && turnId && !stale && isRecord(params.turn)) {
      const root = typeof params.turn.rootTurnId === 'string' ? params.turn.rootTurnId : undefined
      if (!turn.id) { turn.id = turnId; turn.markStarted(turnId) } else if (root === turn.id && turnId !== turn.id) turn.aliases.add(turnId)
    }
    if (method === 'turn/completed' && turnId) this.endWaiters.get(turnId)?.()
    // A command an ended turn left running says it ended under that turn's id: read before the drop below.
    if (method === 'item/completed' && isRecord(params.item)) this.background.noteItemCompleted(params.item)
    if (method === 'item/commandExecution/terminalInteraction') this.background.noteTerminalInteraction(params)
    // A late event of a turn that already ended (or of none we started) is dropped.
    if (turnId && (stale || !turn || (turn.id && !turn.owns(turnId)))) {
      if (method !== 'thread/tokenUsage/updated') return
    }
    this.touch()
    if (turn && isRecord(params.item)) {
      if (method === 'item/started') turn.noteItemStarted(params.item)
      else if (method === 'item/completed') turn.noteItemCompleted(params.item)
    }
    if (method === 'thread/tokenUsage/updated' && isRecord(params.tokenUsage)) {
      this.lastUsage = { usage: turnUsage(params.tokenUsage), window: typeof params.tokenUsage.modelContextWindow === 'number' ? params.tokenUsage.modelContextWindow : undefined }
      if (turn && !stale) turn.usage = this.lastUsage.usage
    }
    // A review's child turn ends before its root: only the root's end is the turn's.
    if (method === 'turn/completed' && turn && isRecord(params.turn) && (!turnId || turnId === turn.id)) {
      this.events.endTurn()
      this.completeTurn(turn, params.turn)
      return
    }
    this.events.onNotification(method, params)
  }

  private completeTurn(turn: LiveTurn, t: Record<string, unknown>): void {
    const status = t.status
    if (status === 'failed') {
      const err = isRecord(t.error) ? t.error : {}
      const message = typeof err.message === 'string' && err.message ? err.message : 'Codex turn failed'
      this.endTurn(turn, { error: new CodexTurnError(message, {
        message,
        codexErrorInfo: err.codexErrorInfo ?? null,
        additionalDetails: err.additionalDetails ?? null,
      }) })
      return
    }
    // A stop is on its way: the turn ends here, with no follow-up and no plan question.
    if (turn.stopping) {
      if (turn.unanswered.length > 0) this.sayUnanswered(turn, 'The turn stopped before Codex answered')
      this.endTurn(turn, { stopReason: 'cancelled' }, true)
      return
    }
    if (status === 'completed') {
      // Codex took a steer after the model's last word and ended without answering it.
      if (turn.unanswered.length > 0) {
        if (turn.continuations < MAX_CONTINUATIONS) {
          this.continueTurn(turn, turn.unanswered.join('\n\n'))
          return
        }
        // Never dropped in silence: say which words Codex left unanswered.
        this.sayUnanswered(turn, 'Codex ended its turn without answering')
      }
      if (turn.plan && this.controls.collaboration === 'plan') {
        void this.askToImplement(turn, turn.plan)
        return
      }
    }
    this.endTurn(turn, { stopReason: status === 'interrupted' ? 'cancelled' : 'end_turn' })
  }

  /** Names in the chat the words Codex took into this turn and never answered. */
  private sayUnanswered(turn: LiveTurn, lead: string): void {
    this.emit({
      sessionUpdate: 'agent_message_chunk',
      messageId: `codex-unanswered:${turn.continuations}`,
      content: { type: 'text', text: `${lead}: ${turn.unanswered.map((t) => `"${t}"`).join(', ')}. Send it again to ask once more.\n\n` },
    })
  }

  /** Plan mode: the plan is done; implement it? Yes leaves plan mode and goes on in the same turn. */
  private async askToImplement(turn: LiveTurn, plan: { id: string; text: string }): Promise<void> {
    for (const id of turn.ids()) this.retireTurnId(id)
    turn.holding = true
    const approved = await this.approvals.askPlan(plan.id, plan.text)
    turn.holding = false
    if (turn.settled || this.turn !== turn) return
    if (turn.stopping) { this.endTurn(turn, { stopReason: 'cancelled' }, true); return }
    if (!approved) { this.endTurn(turn, { stopReason: 'end_turn' }); return }
    this.controls.set('collaboration_mode', 'default')
    this.emit({ sessionUpdate: 'config_option_update', configOptions: this.controls.sessionState().configOptions })
    this.continueTurn(turn, IMPLEMENT_PLAN_TEXT)
  }

  private retireTurnId(id: string): void {
    this.endedTurnIds.add(id)
    if (this.endedTurnIds.size > 64) this.endedTurnIds.delete(this.endedTurnIds.values().next().value as string)
  }

  /**
   * A turn Codex ended: what it left running is read and reported first (background.ts), so
   * the worker journals it ahead of the turn's end; then the turn settles. `stopped`: a stop
   * ends those commands, so none is reported.
   */
  private endTurn(turn: LiveTurn, outcome: { stopReason: string } | { error: Error }, stopped = false): void {
    if (turn.settled || turn.ending) return
    turn.ending = true
    void this.background.turnEnded({ stopped }).catch(() => {}).then(() => this.settleTurn(turn, outcome))
  }

  private settleTurn(turn: LiveTurn, outcome: { stopReason: string } | { error: Error }): void {
    if (turn.settled) return
    for (const id of turn.ids()) this.retireTurnId(id)
    if (this.turn === turn) this.turn = null
    turn.settle(outcome)
  }

  private checkStall(): void {
    const turn = this.turn
    if (!turn || turn.settled || turn.ending || this.approvals.waiting) return
    const limit = this.events.itemRunning ? stallItemMs(this.env) : stallIdleMs(this.env)
    const quietMs = Date.now() - turn.lastEventAt
    if (quietMs < limit) return
    const minutes = Math.round(quietMs / 60_000)
    this.settleTurn(turn, { error: new CodexTurnError(
      `Codex sent nothing for ${minutes} minutes, so Walnut stopped the turn (operation timed out).`,
      { walnutError: 'turn_stalled' },
    ) })
    // Interrupt it at Codex; one that does not answer is ended with its process.
    const cleanup = this.cancelStalled(turn).finally(() => { if (this.stallCleanup === cleanup) this.stallCleanup = null })
    this.stallCleanup = cleanup
  }

  /**
   * Interrupt a turn Walnut already ended, and wait for Codex to end it too: an answered
   * interrupt is not an ended turn, and Codex refuses every next turn/start while it runs.
   * One that does not end in time is ended with its process.
   */
  private async cancelStalled(turn: LiveTurn): Promise<void> {
    const turnId = turn.id
    if (!turnId || !this.threadId) { this.rpc.kill(); return }
    const ended = new Promise<true>((res) => this.endWaiters.set(turnId, () => res(true)))
    const deadline = Date.now() + INTERRUPT_TIMEOUT_MS
    try {
      await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId }, INTERRUPT_TIMEOUT_MS)
      if (await withTimeout(ended, Math.max(1, deadline - Date.now())) !== true) this.rpc.kill()
    } catch {
      this.rpc.kill()
    } finally {
      this.endWaiters.delete(turnId)
    }
  }

  private onExit(exit: AppServerExit): void {
    if (this.watchdog) clearInterval(this.watchdog)
    this.approvals.cancelAll()
    this.background.gone()
    const turn = this.turn
    if (turn) {
      const how = exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`
      this.settleTurn(turn, { error: new CodexTurnError(
        `Codex app-server stopped unexpectedly (${how}, connection closed). The next message starts it again.`,
        { walnutError: 'app_server_exited' },
      ) })
    }
    if (!this.closing) {
      // The turn's rejection is journaled first (a microtask), then the worker goes.
      setImmediate(() => this.hooks.onExit(exit))
    }
  }
}
