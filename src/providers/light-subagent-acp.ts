/**
 * One light-subagent prompt on an ACP engine: the host's daemon starts a worker for it
 * (the same `acpStart` a task session uses, under a runtime id no session record
 * names), the prompt runs as one turn, the journal it writes streams back here, and
 * the worker is stopped once the turn ends, the run is stopped or its time is up.
 */
import crypto from 'node:crypto'
import { log } from '../logging/index.js'
import { WALNUT_HOME } from '../constants.js'
import { engineCaps } from '../core/agents/engine-registry.js'
import type { DaemonConnection, DaemonEvent } from './daemon-connection.js'
import { LightSubagentError, type LightRunResult, type LightRunSpec } from '../core/subagents/types.js'

const START_TIMEOUT_MS = 5 * 60_000
const OP_TIMEOUT_MS = 30_000
/** The host's daemon stops a worker nobody has subscribed to for this long (its server is gone). */
const ORPHAN_GRACE_MS = 2 * 60_000
/** How often a run looks for a new link to subscribe on again. */
const RESUBSCRIBE_CHECK_MS = 2_000
/** What of the answer a progress event carries at most (the reader shows the latest). */
const PROGRESS_TEXT_MAX = 20_000

interface AcpChoice { value: string; name?: string }
interface AcpControl { id: string; currentValue?: string; options?: AcpChoice[] }

interface TestWiring { wsUrl: string; artifacts: { workerCmd: string[]; adapterCmd: string[] }; env?: Record<string, string>; conn?: DaemonConnection }
let testWiring: TestWiring | null = null
/** Tests: a daemon to run on and the worker/adapter commands to run (a mock agent). */
export function _setLightAcpTestWiring(w: TestWiring | null): void { testWiring = w }

async function connect(host: string): Promise<DaemonConnection> {
  if (testWiring?.conn) return testWiring.conn
  if (testWiring) return (await import('./daemon-connection.js')).getDirectDaemonConnection('__local__', testWiring.wsUrl)
  return (await import('../core/hosts/link.js')).link(host)
}

export async function runAcpLight(spec: LightRunSpec): Promise<LightRunResult> {
  const caps = engineCaps(spec.engine)
  const remote = spec.host !== '__local__'
  let conn: DaemonConnection
  const unreachable = (why: string) => new LightSubagentError('host_unreachable', `Walnut cannot reach ${spec.host} to run ${caps.displayName}: ${why}`, 503)
  try {
    conn = await connect(spec.host)
  } catch (err) {
    throw unreachable(err instanceof Error ? err.message : String(err))
  }
  // A link that died out of sight would hold the start for minutes: ask it first.
  if (remote && !testWiring) {
    const { hostLinkAnswers } = await import('../core/hosts/remote-read-bound.js')
    if (!(await hostLinkAnswers(spec.host))) throw unreachable('its link does not answer right now. Try again in a moment')
  }
  if (remote && !conn.hasCapability('acp-host-v1')) {
    throw new LightSubagentError('engine_unavailable', `${caps.displayName} cannot run on ${spec.host}: its daemon does not run ACP engines (it is older than this Walnut, or runs without bun)`)
  }
  // Its daemon must end the worker itself should this server go away mid-run.
  if (!conn.hasCapability('acp-light-bounds-v1')) {
    throw new LightSubagentError('engine_unavailable', `${caps.displayName} subagents need a newer Walnut daemon on ${spec.host === '__local__' ? 'this machine' : spec.host}: it updates by itself, so try again in a while, or use the claude engine`)
  }
  if (remote && conn.readOnlyRemote) {
    throw new LightSubagentError('engine_unavailable', `${caps.displayName} on ${spec.host} is not started from a test server: that host's daemon is shared with the real Walnut`)
  }
  const launch = await import('./acp-launch.js')
  let artifacts: Awaited<ReturnType<typeof launch.acpLaunchArtifacts>>
  try {
    artifacts = testWiring?.artifacts ?? await launch.acpLaunchArtifacts(spec.engine, remote)
  } catch (err) {
    throw new LightSubagentError('engine_unavailable', err instanceof Error ? err.message : String(err))
  }
  const env = { ...await adapterEnv(spec, remote, artifacts), ...(testWiring?.env ?? {}) }
  const acp = await import('./acp-session.js')

  const warnings: string[] = []
  const { AcpJournalProjector } = await import('./acp-journal-projector.js')
  const { AcpStreamNormalizer } = await import('./acp-stream-normalizer.js')
  const normalizer = new AcpStreamNormalizer(new AcpJournalProjector(spec.runtimeId))
  let seenV = 0
  let answerSoFar = ''
  let tokens: number | undefined
  let settle!: { resolve: (r: LightRunResult) => void; reject: (e: Error) => void }
  const done = new Promise<LightRunResult>((resolve, reject) => { settle = { resolve, reject } })
  // A stop while the start is still in flight rejects this before anyone awaits it.
  done.catch(() => {})
  let finished = false
  const finish = (fn: () => void) => { if (!finished) { finished = true; fn() } }
  let lastError: string | undefined
  /** The prompt is in: an error from here on is the turn's. One before it (a refused control) is not. */
  let promptSent = false

  const answerPermission = (requestId: string, options: Array<{ optionId?: string; kind?: string }>) => {
    const optionId = acp.permissionOptionFor(options, spec.fullAccess)
    void conn.send('acpRespond', {
      sid: spec.runtimeId, commandId: `qp-${crypto.randomBytes(6).toString('hex')}`, providerRequestId: requestId, optionId,
    }, OP_TIMEOUT_MS).catch(() => {})
  }

  const onLine = (line: string) => {
    let record: import('./acp-worker/protocol.js').JournalRecord
    try { record = JSON.parse(line) } catch { return }
    if (record.kind === 'meta' && record.event.type === 'error') lastError = record.event.message
    for (const event of normalizer.normalize(record)) {
      const p = event.payload
      switch (event.name) {
        case 'session:text-delta':
          answerSoFar += String(p.delta ?? '')
          spec.onProgress({ kind: 'text', text: answerSoFar.slice(-PROGRESS_TEXT_MAX) })
          break
        case 'session:tool-use':
          answerSoFar = ''
          spec.onProgress({ kind: 'tool', toolName: String(p.toolName ?? 'tool') })
          break
        case 'session:usage-update':
          if (typeof p.used === 'number' && p.used > 0) { tokens = p.used; spec.onProgress({ kind: 'tokens', tokens: p.used }) }
          break
        case 'session:permission-request':
          answerPermission(String(p.requestId ?? ''), Array.isArray(p.acpOptions) ? p.acpOptions as Array<{ optionId?: string; kind?: string }> : [])
          break
        case 'session:error':
          // The turn failed (sign-in, usage limit, the provider): no result follows it.
          lastError = String(p.error ?? lastError ?? 'the engine reported an error')
          if (promptSent) finish(() => settle.reject(new LightSubagentError('engine_error', `${caps.displayName}: ${lastError}`)))
          break
        case 'session:result': {
          const answer = String(p.result ?? '').trim()
          const stop = String(p.stopReason ?? '')
          if (stop === 'cancelled') finish(() => settle.reject(new LightSubagentError('engine_error', 'The run was stopped', 409)))
          else if (!answer && lastError) finish(() => settle.reject(new LightSubagentError('engine_error', `${caps.displayName}: ${lastError}`)))
          else finish(() => settle.resolve({ answer, ...(tokens ? { tokens } : {}), warnings }))
          break
        }
      }
    }
  }
  const off = conn.onEvent((ev: DaemonEvent) => {
    if (ev.sid !== spec.runtimeId) return
    if (ev.ev === 'jsonl' && typeof ev.line === 'string') {
      const v = typeof ev.v === 'number' ? ev.v : 0
      if (v <= seenV) return
      seenV = v
      onLine(ev.line)
    } else if (ev.ev === 'acp_state' && ev.state === 'dead') {
      finish(() => settle.reject(new LightSubagentError('engine_error', `${caps.displayName} stopped before it answered${lastError ? `: ${lastError}` : ''}`)))
    }
  })
  const onAbort = () => {
    void conn.send('acpCancel', { sid: spec.runtimeId, commandId: `qx-${crypto.randomBytes(6).toString('hex')}`, hard: true }, OP_TIMEOUT_MS).catch(() => {})
    finish(() => settle.reject(new LightSubagentError('engine_error', 'The run was stopped', 409)))
  }
  spec.signal.addEventListener('abort', onAbort, { once: true })
  // A link that dropped and came back no longer carries this worker's journal: subscribe
  // again from the last byte read, so lines written meanwhile (its answer) are read too.
  let epoch = conn.connectionEpoch
  let resubscribing = false
  const watch = setInterval(() => {
    if (finished || resubscribing || !conn.connected || conn.connectionEpoch === epoch) return
    resubscribing = true
    const at = conn.connectionEpoch
    void conn.send('acpSubscribe', { sid: spec.runtimeId, fromOffset: seenV }, OP_TIMEOUT_MS).then((r) => {
      if (r.ok) { epoch = at; return }
      finish(() => settle.reject(new LightSubagentError('engine_error', `${caps.displayName}'s worker on ${spec.host} ended while Walnut's link to it was down${lastError ? `: ${lastError}` : ''}`)))
    }, () => { /* the link dropped again: the next check tries again */ }).finally(() => { resubscribing = false })
  }, RESUBSCRIBE_CHECK_MS)
  watch.unref?.()
  try {
    if (spec.signal.aborted) throw new LightSubagentError('engine_error', 'The run was stopped', 409)
    const startResp = await conn.send('acpStart', {
      sid: spec.runtimeId,
      cwd: spec.cwd,
      ...artifacts,
      env: remote ? acp.hostAdapterEnv(env) : acp.acpStartEnv(env),
      fromOffset: 0,
      mcpServers: [],
      // Bounds the host's daemon keeps by itself, should this server go away mid-run.
      deadlineAt: spec.deadlineAt,
      orphanGraceMs: ORPHAN_GRACE_MS,
      // The parent's task directory: the child works where its parent keeps its work.
      ...(spec.parentTaskId ? { taskId: spec.parentTaskId, home: WALNUT_HOME } : {}),
    }, START_TIMEOUT_MS)
    if (!startResp.ok) throw new LightSubagentError('engine_unavailable', `${caps.displayName} did not start: ${String(startResp.error ?? 'unknown error')}`)
    const state = (startResp as { state?: { configOptions?: AcpControl[] } }).state
    await applyChoices(conn, spec, state?.configOptions ?? [], warnings)
    if (spec.signal.aborted) throw new LightSubagentError('engine_error', 'The run was stopped', 409)
    const messageId = `lsa-${crypto.randomBytes(6).toString('hex')}`
    promptSent = true
    lastError = undefined
    const sent = await conn.send('acpSend', { sid: spec.runtimeId, commandId: `acp-prompt:${messageId}`, walnutMessageId: messageId, text: spec.prompt }, OP_TIMEOUT_MS)
    if (!sent.ok) throw new LightSubagentError('engine_error', `${caps.displayName} did not take the prompt: ${String(sent.error ?? 'unknown error')}`)
    return await done
  } finally {
    finished = true
    clearInterval(watch)
    spec.signal.removeEventListener('abort', onAbort)
    off()
    // Its whole process group ends, the commands its tools started included, before the
    // run gives up its slot (a graceful stop ends the worker and leaves those).
    const ended = await conn.send('acpCancel', { sid: spec.runtimeId, commandId: `qx-${crypto.randomBytes(6).toString('hex')}`, hard: true }, OP_TIMEOUT_MS)
      .catch((err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err), errorKind: undefined }))
    // no_worker: it had ended already.
    if (!ended.ok && (ended as { errorKind?: string }).errorKind !== 'no_worker') {
      log.agent.warn('light subagent: worker did not end', { runtimeId: spec.runtimeId, host: spec.host, error: String(ended.error ?? '') })
    }
  }
}

/**
 * The model, effort and permission preset, set through the engine's own controls before
 * the prompt goes in. A model the engine does not list is refused (the list is named), an
 * effort it has no control for is a warning. Codex takes model and effort at start.
 */
async function applyChoices(conn: DaemonConnection, spec: LightRunSpec, controls: AcpControl[], warnings: string[]): Promise<void> {
  const set = async (configId: string, value: string) => {
    const resp = await conn.send('acpSetConfigOption', { sid: spec.runtimeId, commandId: `acp-config-${crypto.randomBytes(8).toString('hex')}`, configId, value }, OP_TIMEOUT_MS)
    return resp.ok === true
  }
  const caps = engineCaps(spec.engine)
  // Codex takes model and effort at start (its adapter env); the others through their controls.
  if (caps.id !== 'codex') await applyModelAndEffort(spec, controls, warnings, set)
  await applyPosture(spec, controls, set)
}

async function applyModelAndEffort(spec: LightRunSpec, controls: AcpControl[], warnings: string[], set: (id: string, value: string) => Promise<boolean>): Promise<void> {
  const caps = engineCaps(spec.engine)
  const acp = await import('./acp-session.js')
  if (spec.model) {
    const { base, effort } = acp.splitAcpModelId(spec.model)
    const control = controls.find((c) => c.id === 'model')
    const listed = control?.options?.map((o) => o.value) ?? []
    if (listed.length > 0 && !listed.includes(base)) {
      throw new LightSubagentError('model_unavailable', `${caps.displayName} does not offer model "${base}". It offers: ${listed.slice(0, 15).join(', ')}${listed.length > 15 ? `, and ${listed.length - 15} more` : ''}`, 409, { models: listed })
    }
    if (!await set('model', base)) throw new LightSubagentError('model_unavailable', `${caps.displayName} refused model "${base}"`)
    if (effort && !spec.effort) spec = { ...spec, effort }
  }
  if (spec.effort) {
    const control = controls.find((c) => c.id === 'reasoning_effort' || c.id === 'effort')
    if (!control) warnings.push(`${caps.displayName} has no effort control; it ran at its own default.`)
    else if (!await set(control.id, spec.effort)) warnings.push(`${caps.displayName} refused effort "${spec.effort}"; it ran at its own default.`)
  }
}

/**
 * The permission preset. A full-access parent's child is moved to full access where the
 * engine has it (else it asks, and every ask is allowed). Any other parent's child must
 * end up in a preset that asks or only reads before the prompt goes in: one the engine
 * keeps in full access (its own settings started it there, it has no other preset, or it
 * refused the switch) would act without asking, so the run is refused instead.
 */
async function applyPosture(spec: LightRunSpec, controls: AcpControl[], set: (id: string, value: string) => Promise<boolean>): Promise<void> {
  const caps = engineCaps(spec.engine)
  const { ACP_FULL_ACCESS_MODE_VALUES } = await import('./acp-permission-posture.js')
  const mode = controls.find((c) => c.id === 'mode')
  if (spec.fullAccess) {
    const fullValue = mode?.options?.find((o) => ACP_FULL_ACCESS_MODE_VALUES.has(o.value))?.value
    if (fullValue && mode?.currentValue !== fullValue) await set('mode', fullValue)
    return
  }
  const readValue = mode?.options?.find((o) => o.value === 'read-only' || o.value === 'plan')?.value
  if (readValue && mode?.currentValue !== readValue && await set('mode', readValue)) return
  if (mode?.currentValue && ACP_FULL_ACCESS_MODE_VALUES.has(mode.currentValue)) {
    throw new LightSubagentError('engine_unavailable',
      `${caps.displayName} runs with full access here (its preset "${mode.currentValue}") and ${readValue ? 'refused the read-only one' : 'offers no read-only preset'}, `
        + 'and your session does not run with full access, so the subagent was not started. Run it from a full-access session, or pick another engine.')
  }
}

/** The adapter env: the operator's `engines.<id>.env`, Codex's provider and pick, the parent's identity. */
async function adapterEnv(spec: LightRunSpec, remote: boolean, artifacts: unknown): Promise<Record<string, string>> {
  const launch = await import('./acp-launch.js')
  const acp = await import('./acp-session.js')
  const { walnutApiEnvForSession } = await import('../lib/self-api-root.js')
  const overlay = await launch.configuredEngineEnv(spec.engine)
  const walnutApiEnv = walnutApiEnvForSession(spec.host)
  if (spec.engine !== 'codex') {
    const managed = acp.buildAcpAdapterEnv(undefined, { sessionId: spec.callerSid, walnutApiEnv })
    let provider: Record<string, string> | undefined
    if (spec.engine === 'pi' && !remote && artifacts && typeof artifacts === 'object' && 'adapterCmd' in artifacts) {
      try {
        const { mergeAcpSpawnEnv } = await import('./acp-worker/protocol.js')
        provider = { PI_ACP_PI_COMMAND: acp.resolveEngineExecutable({ engine: 'pi', cwd: spec.cwd, env: mergeAcpSpawnEnv(process.env, overlay) }) }
      } catch { /* the adapter finds pi on PATH itself */ }
    }
    return { ...(overlay ?? {}), ...(provider ?? {}), ...(managed ?? {}) }
  }
  const { codexWalnutConfig } = await import('./codex-engine-source.js')
  const { resolveCodexEngine } = await import('./codex-engine-config.js')
  const { CODEX_TRANSPORT_ENV, resolveCodexTransport } = await import('./codex-app-server/transport.js')
  const walnutConfig = await codexWalnutConfig()
  const base = acp.splitAcpModelId(spec.model ?? '')
  const effort = spec.effort ?? base.effort
  const codex = resolveCodexEngine(
    walnutConfig,
    overlay && Object.hasOwn(overlay, 'CODEX_CONFIG') ? overlay.CODEX_CONFIG : (remote ? undefined : process.env.CODEX_CONFIG),
    base.base ? { pick: { model: base.base, ...(effort ? { reasoning_effort: effort } : {}) } } : {},
  )
  const baseConfig = !base.base && effort ? { ...(codex.baseConfig ?? {}), model_reasoning_effort: effort } : codex.baseConfig
  let providerExecutable: string | undefined
  if (!remote && !testWiring) {
    const { mergeAcpSpawnEnv } = await import('./acp-worker/protocol.js')
    try {
      providerExecutable = acp.resolveEngineExecutable({ engine: 'codex', cwd: spec.cwd, env: mergeAcpSpawnEnv(process.env, overlay) })
    } catch (err) {
      throw new LightSubagentError('engine_unavailable', err instanceof Error ? err.message : String(err))
    }
  }
  const managed = acp.buildAcpAdapterEnv(providerExecutable, {
    baseConfig,
    sessionId: spec.callerSid,
    initialAgentMode: spec.fullAccess ? 'agent-full-access' : 'read-only',
    walnutApiEnv,
    codexModelPrefix: codex.prefix,
  })
  return { ...(overlay ?? {}), ...(managed ?? {}), [CODEX_TRANSPORT_ENV]: resolveCodexTransport(walnutConfig, process.env, { adapterGiven: false }) }
}
