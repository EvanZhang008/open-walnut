/**
 * Cloud-companion setup job: a single-instance, resumable state machine.
 *
 * State lives at <WALNUT_HOME>/cloud-setup-job.json (atomic write, mode 0600,
 * a CRITICAL_IGNORE so it never enters the git-synced data repo). The runner
 * persists after every transition, so a Mac reboot mid-provision resumes where
 * it left off (resumeCloudSetupJobIfAny(), called from server startup).
 *
 * SECURITY invariants, enforced here and nowhere else:
 *   - `pairingCode` and provider credentials NEVER reach a REST response, an
 *     SSE payload, a bus event, a logTail line, or a log.* call. Everything
 *     that leaves the process goes through redactCloudSetupJob().
 *   - Credentials are never persisted at all — they live in a module-level map
 *     keyed by job id, so a restart mid-provision parks the job on
 *     awaiting-input {kind:'credentials'} instead of silently losing them.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { CLOUD_MODE, WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { emitSse } from '../../web/sse-channels.js'
import { bus, EventNames } from '../event-bus.js'
import {
  CLOUD_SETUP_LOG_TAIL_MAX,
  CLOUD_SETUP_STEP_IDS,
  type CloudSetupAwaitingInput,
  type CloudSetupDomainMode,
  type CloudSetupJobState,
  type CloudSetupProviderId,
  type CloudSetupStepId,
  type RedactedCloudSetupJobState,
  type SetupProgressEvent,
} from './job-types.js'
import { getDriver } from './providers/index.js'
import { CloudSetupCancelled, sslipHostname, stepRunners, type StepContext } from './steps.js'

/** SSE channel key — the web wizard subscribes here. */
export const CLOUD_SETUP_SSE_CHANNEL = 'cloud-setup'

export class CloudSetupJobExistsError extends Error {
  constructor() {
    super('A cloud setup job is already in progress. Cancel it, or start with force to replace it.')
    this.name = 'CloudSetupJobExistsError'
  }
}

export interface StartCloudSetupJobInput {
  provider: CloudSetupProviderId
  domainMode: CloudSetupDomainMode
  domain?: string
  region?: string
  instanceType?: string
  credentials?: string
  force?: boolean
}

export interface CloudSetupJobInput {
  ip?: string
  credentials?: string
  confirmDnsSkip?: boolean
}

function jobFilePath(): string {
  return path.join(WALNUT_HOME, 'cloud-setup-job.json')
}

// ── In-memory runner state ──────────────────────────────────────────────────
//
// One job at a time, but keyed by id anyway so a stale runner can tell it has
// been superseded (force-start) and stop touching the file.

interface RunnerHandle {
  jobId: string
  cancelled: boolean
  /** Set when the operator answers a requestConfirmation prompt. */
  confirmed: boolean
  force: boolean
  /**
   * Aborted by cancelJob. The cooperative `cancelled` flag is only observed
   * between polls, so on its own it lets a 30-minute provider deploy keep
   * provisioning chargeable resources after the operator cancelled. The signal
   * is what reaches a live child process / in-flight fetch.
   */
  controller: AbortController
}

let active: RunnerHandle | null = null
/**
 * Serializes concurrent starts. Two POSTs (two browser tabs, or the wizard and
 * the shipped skill racing) both passed the existing-job check and both spawned
 * a runner, and the loser's provider API token lingered in credentialStore
 * forever. The second caller awaits the first, then re-runs the check and
 * throws CloudSetupJobExistsError exactly as a sequential second call would.
 */
let startInFlight: Promise<CloudSetupJobState> | null = null
/** Provider credentials, never persisted. Keyed by job id. */
const credentialStore = new Map<string, string>()
/** Cached state so a GET doesn't have to hit disk on every poll. */
let cached: CloudSetupJobState | null = null

// ── Persistence ─────────────────────────────────────────────────────────────

async function persist(state: CloudSetupJobState): Promise<void> {
  state.updatedAt = new Date().toISOString()
  cached = state
  const file = jobFilePath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  // Unique per write, not just per process: two overlapping persists (a
  // requestConfirmation landing while the step loop transitions) would
  // otherwise share one tmp path and race the rename to ENOENT.
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  await fs.rename(tmp, file)
}

async function loadFromDisk(): Promise<CloudSetupJobState | null> {
  try {
    const raw = await fs.readFile(jobFilePath(), 'utf-8')
    const parsed = JSON.parse(raw) as CloudSetupJobState
    if (parsed.version !== 1 || typeof parsed.id !== 'string') return null
    // Older/partial files may lack step slots added later.
    for (const id of CLOUD_SETUP_STEP_IDS) parsed.steps[id] ??= { status: 'pending' }
    parsed.logTail ??= []
    return parsed
  } catch {
    return null
  }
}

/** Current job (cached, falling back to disk). Null when none exists. */
export async function getCloudSetupJob(): Promise<CloudSetupJobState | null> {
  if (cached) return cached
  cached = await loadFromDisk()
  return cached
}

/** Delete a terminal job record. Throws when one is still in flight. */
export async function deleteCloudSetupJob(): Promise<boolean> {
  const state = await getCloudSetupJob()
  if (!state) return false
  if (state.status === 'running' || state.status === 'awaiting-input') throw new CloudSetupJobExistsError()
  credentialStore.delete(state.id)
  cached = null
  active = null
  await fs.rm(jobFilePath(), { force: true })
  return true
}

// ── Redaction ───────────────────────────────────────────────────────────────

/**
 * The ONLY shape allowed out of this module. Strips the pairing code; provider
 * credentials are never in the state to begin with.
 */
export function redactCloudSetupJob(state: CloudSetupJobState): RedactedCloudSetupJobState {
  const { pairingCode: _pairingCode, ...rest } = state
  return rest
}

// ── Progress ────────────────────────────────────────────────────────────────

function emitProgress(state: CloudSetupJobState, logLines?: string[]): void {
  const payload: SetupProgressEvent = {
    jobId: state.id,
    status: state.status,
    currentStep: state.currentStep,
    steps: state.steps,
    ...(logLines && logLines.length > 0 ? { logLines } : {}),
    ...(state.awaitingInput ? { awaitingInput: state.awaitingInput } : {}),
    ...(state.error ? { error: state.error } : {}),
    updatedAt: state.updatedAt,
  }
  emitSse(CLOUD_SETUP_SSE_CHANNEL, 'progress', payload)
  bus.emit(EventNames.CLOUD_SETUP_UPDATE, {
    jobId: state.id,
    status: state.status,
    currentStep: state.currentStep,
  }, ['web-ui'], { source: 'cloud-setup' })
}

// ── Start ───────────────────────────────────────────────────────────────────

function freshSteps(): Record<CloudSetupStepId, { status: 'pending' }> {
  return Object.fromEntries(
    CLOUD_SETUP_STEP_IDS.map((id) => [id, { status: 'pending' as const }]),
  ) as Record<CloudSetupStepId, { status: 'pending' }>
}

export async function startCloudSetupJob(input: StartCloudSetupJobInput): Promise<CloudSetupJobState> {
  // Serialize: an overlapping caller must see the first job as "existing".
  const previous = startInFlight
  const mine = (async () => {
    // Swallow the predecessor's outcome: we only need it to have finished, so
    // that the existing-job check below sees the job it created.
    await previous?.catch(() => {})
    return startJobExclusive(input)
  })()
  startInFlight = mine
  try {
    return await mine
  } finally {
    if (startInFlight === mine) startInFlight = null
  }
}

async function startJobExclusive(input: StartCloudSetupJobInput): Promise<CloudSetupJobState> {
  const existing = await getCloudSetupJob()
  if (existing && (existing.status === 'running' || existing.status === 'awaiting-input') && !input.force) {
    throw new CloudSetupJobExistsError()
  }
  if (existing) {
    // Superseded: stop the old runner before its next persist, and abort its
    // in-flight work so a replaced provision does not keep provisioning.
    if (active) {
      active.cancelled = true
      active.controller.abort()
    }
    credentialStore.delete(existing.id)
  }
  if (!getDriver(input.provider)) throw new Error(`Unknown provider: ${input.provider}`)

  const now = new Date().toISOString()
  const state: CloudSetupJobState = {
    version: 1,
    id: `cs-${crypto.randomBytes(6).toString('hex')}`,
    provider: input.provider,
    domainMode: input.domainMode,
    ...(input.domain ? { domain: input.domain } : {}),
    ...(input.region ? { region: input.region } : {}),
    ...(input.instanceType ? { instanceType: input.instanceType } : {}),
    status: 'running',
    currentStep: 'preflight',
    steps: freshSteps(),
    ...(input.force ? { force: true } : {}),
    logTail: [],
    createdAt: now,
    updatedAt: now,
  }
  if (input.credentials) credentialStore.set(state.id, input.credentials)
  try {
    await persist(state)
  } catch (err) {
    // The job never became real, so its credential must not outlive the call.
    credentialStore.delete(state.id)
    throw err
  }
  emitProgress(state)
  log.web.info('cloud-setup: job started', {
    jobId: state.id, provider: state.provider, domainMode: state.domainMode,
  })
  void runJob(state, { force: input.force === true })
  return state
}

// ── Runner ──────────────────────────────────────────────────────────────────

function stepIndex(id: CloudSetupStepId): number {
  return CLOUD_SETUP_STEP_IDS.indexOf(id)
}

/**
 * Execute steps from `state.currentStep` to the end. Returns when the job is
 * done, failed, cancelled, or parked on operator input.
 */
async function runJob(state: CloudSetupJobState, opts: { force: boolean }): Promise<void> {
  const handle: RunnerHandle = {
    jobId: state.id,
    cancelled: false,
    confirmed: false,
    force: opts.force,
    controller: new AbortController(),
  }
  active = handle
  const runners = stepRunners(opts.force)
  const superseded = (): boolean => active !== handle
  /**
   * Persist only while this runner is still the current one. A cancelled or
   * force-superseded runner must never write: its in-flight persist would land
   * AFTER the replacement job's, clobbering the new job's state with the old
   * job's snapshot (and undoing cancelJob's terminal write).
   */
  const persistIfCurrent = async (): Promise<void> => {
    if (handle.cancelled || superseded()) return
    await persist(state)
  }

  // Batched so a chatty cdk deploy doesn't emit one SSE frame per line.
  let pending: string[] = []
  let flushTimer: NodeJS.Timeout | null = null
  const flush = (): void => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    if (pending.length === 0) return
    const lines = pending
    pending = []
    emitProgress(state, lines)
  }
  /**
   * Last line of defense for the pairing code. Drivers stream provider CLI
   * output verbatim, and that output can legitimately contain the boot script
   * (the aws driver passes it as `-c userDataB64=<base64>`), so a driver that
   * echoes its own command line would otherwise push the secret into logTail —
   * and from there into SSE and every REST response. The runner owns the
   * secret, so the runner scrubs it, whatever the driver does.
   *
   * The `key=<blob>` argv shape is THE motivating case (that is literally what
   * the in-tree aws driver emits) and it is why the token pattern keeps `=` out
   * of the body class: a class containing `=` matches from `userDataB64=`, so
   * the captured token is not valid base64 at offset 0 and the decode yields
   * garbage. Retrying at offsets 0..3 covers every junk prefix: slicing
   * (prefixLength mod 4) characters re-aligns the payload to base64's 4-char
   * groups, so one of the four decodes recovers the script and .includes(code)
   * fires.
   */
  const scrub = (line: string): string => {
    const code = state.pairingCode
    if (!code) return line
    let scrubbed = line.split(code).join('<redacted>')
    // Also catch the code arriving base64-wrapped inside a larger blob.
    for (const token of scrubbed.match(/[A-Za-z0-9+/]{64,}={0,2}/g) ?? []) {
      let hit = false
      for (let off = 0; off < 4 && !hit; off++) {
        if (Buffer.from(token.slice(off), 'base64').toString('utf-8').includes(code)) hit = true
      }
      if (hit) scrubbed = scrubbed.split(token).join('<redacted>')
    }
    return scrubbed
  }
  const appendLog = (rawLine: string): void => {
    const line = scrub(rawLine)
    state.logTail.push(line)
    if (state.logTail.length > CLOUD_SETUP_LOG_TAIL_MAX) {
      state.logTail.splice(0, state.logTail.length - CLOUD_SETUP_LOG_TAIL_MAX)
    }
    pending.push(line)
    if (!flushTimer) {
      flushTimer = setTimeout(flush, 250)
      flushTimer.unref?.()
    }
  }

  const ctx: StepContext = {
    state,
    log: appendLog,
    credentials: credentialStore.get(state.id),
    isCancelled: () => handle.cancelled || superseded(),
    signal: handle.controller.signal,
    requestConfirmation: (awaitingInput: CloudSetupAwaitingInput) => {
      // Poll continues; only the job's outward status changes.
      state.status = 'awaiting-input'
      state.awaitingInput = awaitingInput
      void persistIfCurrent().then(() => emitProgress(state)).catch(() => {})
    },
    confirmed: () => handle.confirmed,
  }

  try {
    for (let i = stepIndex(state.currentStep); i < CLOUD_SETUP_STEP_IDS.length; i++) {
      const id = CLOUD_SETUP_STEP_IDS[i]
      if (handle.cancelled || superseded()) return
      // A step that already completed (resume after the persist but before the
      // next step started) must not re-run — createVM is the expensive one.
      if (state.steps[id].status === 'done' || state.steps[id].status === 'skipped') continue

      state.currentStep = id
      state.status = 'running'
      state.awaitingInput = undefined
      state.error = undefined
      state.steps[id] = { status: 'running', startedAt: new Date().toISOString() }
      await persistIfCurrent()
      emitProgress(state)

      const outcome = await runners[id](ctx)
      if (handle.cancelled || superseded()) return

      if (outcome.pause) {
        state.status = 'awaiting-input'
        state.awaitingInput = outcome.pause
        // The step stays 'pending': provideInput() re-enters it from the top.
        state.steps[id] = { status: 'pending' }
        await persistIfCurrent()
        flush()
        emitProgress(state)
        return
      }

      // A requestConfirmation during the step left status='awaiting-input';
      // completing the step clears it.
      handle.confirmed = false
      state.status = 'running'
      state.awaitingInput = undefined
      state.steps[id] = {
        ...state.steps[id],
        status: outcome.skipped ? 'skipped' : 'done',
        endedAt: new Date().toISOString(),
      }
      await persistIfCurrent()
      flush()
      emitProgress(state)
    }

    state.status = 'done'
    state.currentStep = 'done'
    await persistIfCurrent()
    flush()
    emitProgress(state)
    log.web.info('cloud-setup: job finished', { jobId: state.id, host: state.domain })
  } catch (err) {
    if (handle.cancelled || superseded() || err instanceof CloudSetupCancelled) {
      // cancelJob() already wrote the terminal state.
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    const id = state.currentStep
    state.steps[id] = { ...state.steps[id], status: 'error', error: message, endedAt: new Date().toISOString() }
    state.status = 'failed'
    state.awaitingInput = undefined
    state.error = message
    appendLog(`failed at ${id}: ${message}`)
    await persistIfCurrent().catch(() => {})
    flush()
    emitProgress(state)
    log.web.warn('cloud-setup: job failed', { jobId: state.id, step: id, error: message })
  } finally {
    if (flushTimer) clearTimeout(flushTimer)
    if (active === handle) active = null
  }
}

// ── Operator actions ────────────────────────────────────────────────────────

/** Feed an awaiting-input job and continue. Throws when it isn't waiting. */
export async function provideCloudSetupInput(input: CloudSetupJobInput): Promise<CloudSetupJobState> {
  const state = await getCloudSetupJob()
  if (!state) throw new Error('No cloud setup job exists')
  if (state.status !== 'awaiting-input') {
    throw new Error(`Job is ${state.status}, not awaiting input`)
  }
  const kind = state.awaitingInput?.kind

  if (kind === 'dns-confirm') {
    if (!input.confirmDnsSkip) throw new Error('Send confirmDnsSkip:true to continue without a matching DNS record')
    state.status = 'running'
    state.awaitingInput = undefined
    await persist(state)
    emitProgress(state)
    if (active) {
      // The dns step never stopped polling — flipping the flag lets it return.
      active.confirmed = true
      return state
    }
    // No live runner (the answer arrived after a restart), so the poll that
    // would observe the flag is gone: skip the step outright and continue.
    // Only the dns step may be short-circuited this way — should a later kind
    // ever reuse 'dns-confirm', marking dns 'skipped' from another step would
    // silently skip work that never ran, so fall through to runJob untouched.
    if (state.currentStep === 'dns') {
      state.steps.dns = { status: 'skipped', endedAt: new Date().toISOString() }
      await persist(state)
    }
    void runJob(state, { force: state.force === true })
    return state
  }

  if (kind === 'credentials') {
    if (!input.credentials) throw new Error('This job needs a provider credential to continue')
    credentialStore.set(state.id, input.credentials)
  } else if (kind === 'vm-ip') {
    const ip = (input.ip ?? '').trim()
    const octet = '(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)'
    if (!new RegExp(`^(?:${octet}\\.){3}${octet}$`).test(ip)) throw new Error('Enter a valid IPv4 address')
    state.ip = ip
    if (state.domainMode === 'sslip') state.domain = sslipHostname(ip)
  }

  state.status = 'running'
  state.awaitingInput = undefined
  await persist(state)
  emitProgress(state)
  void runJob(state, { force: active?.force === true || state.force === true })
  return state
}

/** Re-run from the failed step. */
export async function retryCloudSetupJob(): Promise<CloudSetupJobState> {
  const state = await getCloudSetupJob()
  if (!state) throw new Error('No cloud setup job exists')
  if (state.status === 'running') throw new Error('Job is already running')
  if (state.status === 'done') throw new Error('Job already finished')
  // A cancelled job is terminal: the UI only offers Retry on a failed one, and
  // resurrecting one over the raw API would restart a runner the operator
  // deliberately stopped (its credential is already gone from the store).
  if (state.status === 'cancelled') throw new Error('Job was cancelled — start a new one')

  // The failed step (or the current one) goes back to pending so the loop
  // re-enters it; every earlier done/skipped step is left alone.
  state.steps[state.currentStep] = { status: 'pending' }
  state.status = 'running'
  state.error = undefined
  state.awaitingInput = undefined
  await persist(state)
  emitProgress(state)
  // state.force survives a restart; active?.force is the live runner's copy.
  const force = active?.force === true || state.force === true
  void runJob(state, { force })
  return state
}

export async function cancelCloudSetupJob(): Promise<CloudSetupJobState | null> {
  const state = await getCloudSetupJob()
  if (!state) return null
  if (active) {
    active.cancelled = true
    // Reaches the work itself: a provider CLI child process or an in-flight
    // poll, neither of which observes the cooperative flag until it returns.
    active.controller.abort()
  }
  credentialStore.delete(state.id)
  state.status = 'cancelled'
  state.awaitingInput = undefined
  await persist(state)
  emitProgress(state)
  log.web.info('cloud-setup: job cancelled', { jobId: state.id })
  return state
}

// ── Resume on boot ──────────────────────────────────────────────────────────

/**
 * Called from server startup. A 'running' job resumes from its current step
 * (steps are idempotent: generate reuses the code, an aws re-deploy converges
 * on the same stack, polls are pure). 'awaiting-input' needs nothing — the
 * answer arrives over REST. A provider credential does NOT survive a restart,
 * so a job that needs one parks on awaiting-input instead.
 *
 * Runs at most once per process, and never against a job a live runner already
 * owns: server.ts binds the port ~100 lines before it calls this, so a POST
 * /start landing in that window creates a job which resume would otherwise
 * re-run — two runners writing one state object. A second in-process
 * startServer() would double-resume for the same reason.
 */
let resumed = false

export async function resumeCloudSetupJobIfAny(): Promise<void> {
  if (CLOUD_MODE) return // Mac-side feature: the companion never sets one up
  if (resumed) return
  resumed = true
  const runnerBefore = active
  if (runnerBefore) {
    log.web.info('cloud-setup: a runner is already active, skipping resume', { jobId: runnerBefore.jobId })
    return
  }
  const state = await getCloudSetupJob()
  if (!state) return
  if (state.status !== 'running') {
    log.web.info('cloud-setup: found a job, nothing to resume', { jobId: state.id, status: state.status })
    return
  }
  // The await above yields, so a start could have won the race meanwhile.
  const runnerAfter: RunnerHandle | null = active
  if (runnerAfter) {
    log.web.info('cloud-setup: a start beat the resume, skipping', { jobId: runnerAfter.jobId })
    return
  }

  const driver = getDriver(state.provider)
  // Capability, not provider id: aws/azure/gcp drivers authenticate through the
  // operator's own signed-in CLI, so there is nothing to re-collect and asking
  // for an "API token" they ignore would just wedge the job. Only a driver that
  // declares credentialInput:'api-token' actually needs the value back.
  const needsCredentials = driver?.createVM != null
    && state.steps.provision.status !== 'done'
    && driver?.credentialInput === 'api-token'
  if (needsCredentials && !credentialStore.has(state.id)) {
    state.status = 'awaiting-input'
    state.awaitingInput = {
      kind: 'credentials',
      prompt: `Walnut restarted mid-setup. Re-enter your ${driver?.label ?? state.provider} API token to continue.`,
    }
    await persist(state)
    emitProgress(state)
    log.web.info('cloud-setup: resume needs credentials again', { jobId: state.id })
    return
  }

  log.web.info('cloud-setup: resuming job after restart', { jobId: state.id, step: state.currentStep })
  void runJob(state, { force: state.force === true })
}

/** Test-only: drop module state so each test file starts clean. */
export function _resetCloudSetupJobForTesting(): void {
  if (active) {
    active.cancelled = true
    active.controller.abort()
  }
  active = null
  cached = null
  resumed = false
  startInFlight = null
  credentialStore.clear()
}
