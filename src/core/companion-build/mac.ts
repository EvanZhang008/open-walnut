/**
 * The Mac's side of keeping its cloud companion on the Mac's own build
 * (docs/plan/walnut-companion-unified-replica.md, stage 1): look at the box,
 * upload this Mac's companion package, install it, activate it, over the box's
 * /bridge/build door (wire.ts) with this Mac's machine credential.
 *
 * Every step is idempotent on the box, so a tick that stops anywhere (a network
 * error, a Mac restart) is resumed by the next one, which reads the box's status
 * again and goes on from where the box stands. Ticks come after every cloud box
 * probe the companion answered (every 5 minutes), once 60 s after boot, and from
 * the user (Retry, turning updates on). One flow at a time; a tick never rejects.
 *
 * An id the box gave up on, or one this Mac could not build, is never tried
 * again until the Mac's own build changes (or the user presses Retry): the
 * Mac's own record is WALNUT_HOME/cache/companion-build.json.
 */

import path from 'node:path'
import { IS_EPHEMERAL, WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { bootPolicy } from '../boot-policy.js'
import { cloudSessionEndpoint, recoverCloudSessionCredential } from '../cloud-ingest.js'
import { buildCompanionAppPackage, runningBuildId, type CompanionAppPackage } from '../host-server/package.js'
import { getCloudBoxState } from '../hosts/cloud-box-host.js'
import { isLoopbackDomain } from '../hosts/cloud-box-probe.js'
import {
  CHUNK_BYTES, MAX_CHUNK_BYTES,
  type BoxBuildStatus, type InstallRequest, type StepReply, type UploadReply,
} from './wire.js'
import { call, createGaveUpRecord, doorRefusal, look, requestError, sha256InSlices, type Endpoint, type Reply } from './mac-door.js'

export type CompanionBuildState =
  | 'off' | 'no_companion' | 'checking' | 'current' | 'updating' | 'failed'
  | 'unmanaged' | 'box_off' | 'refused_credential' | 'unreachable'

export interface CompanionBuildView {
  state: CompanionBuildState
  /** This Mac's build id; null before it is known or when it runs from source. */
  mine: string | null
  /** The build the companion runs, as it last said. */
  theirs: string | null
  /** `cloud_bridge.auto_update` (default on). */
  autoUpdate: boolean
  step?: 'uploading' | 'installing' | 'starting'
  /** 0..1 while uploading. */
  progress?: number
  message?: string
  /** The end of the box's install log, for a failed install. */
  logTail?: string
  at: number
}

const STATUS_TIMEOUT_MS = 10_000
const CHUNK_TIMEOUT_MS = 120_000
const STEP_TIMEOUT_MS = 30_000
const INSTALL_DEADLINE_MS = 25 * 60_000
const ACTIVATE_DEADLINE_MS = 15 * 60_000
// Short: the row tells the user to update the box once, and after they did it
// should not say so for long. A look costs one small GET.
const UNMANAGED_REST_MS = 10 * 60_000
const REFUSED_REST_MS = 10 * 60_000
const MAX_OFFSET_MISMATCHES = 3
/** Waits before a failed chunk goes again; then the upload pauses until the next look. */
const CHUNK_RETRY_WAITS = [2_000, 5_000, 10_000]

function envMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n >= 0 ? n : fallback
}
const bootDelayMs = () => envMs('WALNUT_COMPANION_BUILD_BOOT_DELAY_MS', 60_000)
const pollMs = () => envMs('WALNUT_COMPANION_BUILD_POLL_MS', 10_000)
/** Tests shrink the chunk retry waits (a factor, 1 by default). */
const retryScale = () => envMs('WALNUT_COMPANION_BUILD_RETRY_SCALE', 1)
const chunkBytes = () => Math.min(MAX_CHUNK_BYTES, Math.max(1, envMs('WALNUT_COMPANION_BUILD_CHUNK_BYTES', CHUNK_BYTES)))

/**
 * Ticks nobody asked for. Off under a test runner unless the test turns them on
 * (WALNUT_COMPANION_AUTO_TICKS=1): a test's server would otherwise update whatever
 * companion it set up, at a time that depends on the machine's load.
 */
function automaticTicksAllowed(): boolean {
  const knob = process.env.WALNUT_COMPANION_AUTO_TICKS?.trim()
  if (knob === '0') return false
  if (knob === '1') return true
  return !(process.env.VITEST || process.env.VITEST_WORKER_ID)
}

let view: CompanionBuildView = { state: 'checking', mine: null, theirs: null, autoUpdate: true, at: Date.now() }
let inFlight: Promise<void> | null = null
let inFlightGen = -1
/** A stop (updates turned off) bumps it: an older flow stops writing the view and ends at its next step. */
let generation = 0
let deferred: Promise<void> | null = null
let restUntil = 0
let myId: string | null | undefined
/** After a Retry: the box's failed record for this id that was already there (null: none) does not count. */
let retryBaseline: { id: string; at: number | null | undefined } | null = null
const gaveUpRecord = createGaveUpRecord(() => path.join(WALNUT_HOME, 'cache', 'companion-build.json'))
const readGaveUp = () => gaveUpRecord.read()
const writeGaveUp = (change: Parameters<typeof gaveUpRecord.write>[0]) => gaveUpRecord.write(change)
let shaCache: { id: string; size: number; sha: string } | null = null
/** Packages the box found damaged (sha256 mismatch), per id: a few are sent again, then it is given up. */
let shaMismatches: { id: string; n: number } | null = null
const MAX_SHA_MISMATCHES = 2

export function companionBuildView(): CompanionBuildView {
  return { ...view }
}

function setView(gen: number, next: Partial<CompanionBuildView> & { state: CompanionBuildState }): void {
  if (gen !== generation) return
  const before = view
  view = { mine: before.mine, theirs: before.theirs, autoUpdate: before.autoUpdate, ...next, at: Date.now() }
  if (view.theirs && view.theirs !== before.theirs) companionBuildChanged(before.theirs ?? null, view.theirs)
  if (before.state !== view.state || before.step !== view.step) {
    log.session.info('companion build: state', {
      state: view.state, was: before.state, mine: view.mine, theirs: view.theirs,
      ...(view.step ? { step: view.step } : {}), ...(view.message ? { why: view.message } : {}),
    })
  }
}

/**
 * The companion runs another build than this server last saw: the copy kinds go
 * to it again now, and a kind its older build refused (`404 unknown_kind`, a
 * 10-minute rest) is asked at once. The first sighting after this server
 * started counts too: a rest from before it is gone with the process anyway.
 */
function companionBuildChanged(was: string | null, now: string): void {
  void Promise.all([import('../replication/replica-status.js'), import('../replication/kinds/copy-kind.js')])
    .then(([status, copies]) => {
      status.forgetTarget('companion')
      copies.copyTargetChanged()
      if (was) log.session.info('companion build: the companion changed build, its copies go again', { was, now })
    })
    .catch(() => { /* the next sweep asks again */ })
}

// --- the gates ----------------------------------------------------------------

type Gate = { open: true; ep: Endpoint; mine: string; autoUpdate: true } | { open: false; state: CompanionBuildState; message?: string; mine: string | null; autoUpdate: boolean }

async function autoUpdateOn(): Promise<boolean> {
  try {
    const { getConfig } = await import('../config-manager.js')
    return (await getConfig()).cloud_bridge?.auto_update !== false
  } catch {
    return true
  }
}

async function gate(): Promise<Gate> {
  if (!bootPolicy('cloud-box-probe')) return { open: false, state: 'off', mine: null, autoUpdate: false }
  const autoUpdate = await autoUpdateOn()
  if (myId === undefined) myId = await runningBuildId().catch(() => null)
  const mine = myId
  if (!autoUpdate) return { open: false, state: 'off', mine, autoUpdate }
  // An ephemeral server runs on a copy of the real data dir: only a loopback
  // companion (one a test started) is ever its own (as in cloud-box-probe.ts).
  if (IS_EPHEMERAL) {
    const box = getCloudBoxState()
    if (!box || !isLoopbackDomain(box.domain)) return { open: false, state: 'no_companion', mine, autoUpdate }
  }
  const ep = await cloudSessionEndpoint()
  if (!ep) return { open: false, state: 'no_companion', mine, autoUpdate }
  if (IS_EPHEMERAL && !isLoopbackDomain(new URL(ep.url).host)) return { open: false, state: 'no_companion', mine, autoUpdate }
  if (!mine) return { open: false, state: 'off', message: 'This Mac runs Walnut from source, so it has no build to send.', mine, autoUpdate }
  return { open: true, ep, mine, autoUpdate: true }
}

async function sha256Of(id: string, tgz: Buffer): Promise<string> {
  if (shaCache && shaCache.id === id && shaCache.size === tgz.length) return shaCache.sha
  const sha = await sha256InSlices(tgz)
  shaCache = { id, size: tgz.length, sha }
  return sha
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// --- the flow -----------------------------------------------------------------

interface Ctx { gen: number; ep: Endpoint; mine: string; theirs: string | null }
type End = 'end'

const live = (ctx: Ctx) => ctx.gen === generation

function failed(ctx: Ctx, why: string, remember: boolean, logTail?: string): End {
  log.session.warn('companion build: failed', { id: ctx.mine, theirs: ctx.theirs, why, remembered: remember })
  setView(ctx.gen, { state: 'failed', mine: ctx.mine, theirs: ctx.theirs, message: why, ...(logTail ? { logTail: logTail.slice(-4000) } : {}) })
  if (retryBaseline?.id === ctx.mine) retryBaseline = null
  if (remember) void writeGaveUp((map) => { map[ctx.mine] = { why, at: Date.now() } })
  return 'end'
}

/** Stopped for now; the next tick reads the status again and goes on. */
function paused(ctx: Ctx, step: 'uploading' | 'installing' | 'starting', message: string, progress?: number): End {
  log.session.info('companion build: paused', { id: ctx.mine, step, why: message })
  setView(ctx.gen, { state: 'updating', mine: ctx.mine, theirs: ctx.theirs, step, message, ...(progress !== undefined ? { progress } : {}) })
  return 'end'
}

function refused(ctx: Ctx, kind: 'unmanaged' | 'refused', httpStatus: number): End {
  if (kind === 'unmanaged') {
    restUntil = Date.now() + UNMANAGED_REST_MS
    setView(ctx.gen, { state: 'unmanaged', mine: ctx.mine, theirs: ctx.theirs })
  } else {
    restUntil = Date.now() + REFUSED_REST_MS
    if (httpStatus === 401) void recoverCloudSessionCredential(ctx.ep.token)
    setView(ctx.gen, { state: 'refused_credential', mine: ctx.mine, theirs: ctx.theirs, message: `HTTP ${httpStatus}` })
  }
  log.session.info('companion build: the companion refused the build door', { id: ctx.mine, kind, status: httpStatus })
  return 'end'
}

/** A failure record of the box for my id that counts (not the one a Retry already saw). */
function boxFailure(status: BoxBuildStatus, mine: string): { why: string } | null {
  const entry = status.failed.find((f) => f.id === mine)
  if (!entry) return null
  if (retryBaseline?.id === mine && entry.at === retryBaseline.at) return null
  return entry
}

/** The door answered with its own refusal of a step (wire StepReply / UploadReply errors). */
function stepRefused(ctx: Ctx, step: 'uploading' | 'installing' | 'starting', reply: { error?: string; message?: string }): End {
  const why = reply.message || reply.error || 'the companion refused the step'
  switch (reply.error) {
    case 'refused': setView(ctx.gen, { state: 'box_off', mine: ctx.mine, theirs: ctx.theirs, message: 'turned_off_on_box' }); return 'end'
    case 'sha_mismatch': {
      // Bytes damaged in transit are worth another upload; a package that never arrives whole is not.
      shaMismatches = shaMismatches?.id === ctx.mine ? { id: ctx.mine, n: shaMismatches.n + 1 } : { id: ctx.mine, n: 1 }
      if (shaMismatches.n <= MAX_SHA_MISMATCHES) return paused(ctx, step, why)
      return failed(ctx, why, true)
    }
    case 'bad_request': case 'too_large': return failed(ctx, why, true)
    case 'disk_full': return failed(ctx, why, false)
    default: return paused(ctx, step, why) // busy, no_package, not_installed, offset trouble: the next tick looks again
  }
}

async function runFlow(reason: string, gen: number): Promise<void> {
  const g = await gate()
  if (gen !== generation) return
  if (!g.open) {
    setView(gen, { state: g.state, mine: g.mine, theirs: view.theirs, autoUpdate: g.autoUpdate, ...(g.message ? { message: g.message } : {}) })
    return
  }
  const userAsked = reason === 'retry' || reason === 'settings'
  if (!userAsked && Date.now() < restUntil) return
  if (view.mine !== g.mine || view.state === 'off' || view.state === 'no_companion') {
    setView(gen, { state: 'checking', mine: g.mine, theirs: view.theirs, autoUpdate: true })
  }
  const ctx: Ctx = { gen, ep: g.ep, mine: g.mine, theirs: view.theirs }
  const first = await look(ctx.ep, STATUS_TIMEOUT_MS)
  if (!live(ctx)) return
  if (first.kind === 'unmanaged' || first.kind === 'refused') { refused(ctx, first.kind, first.httpStatus); return }
  if (first.kind === 'error') {
    if (view.state === 'updating' && view.mine === ctx.mine) paused(ctx, view.step ?? 'uploading', first.message, view.progress)
    else setView(gen, { state: 'unreachable', mine: ctx.mine, theirs: ctx.theirs, message: first.message })
    return
  }
  const status = first.status
  ctx.theirs = status.running.id
  log.session.info('companion build: status', {
    reason, mine: ctx.mine, theirs: ctx.theirs, accepts: status.accepts, current: status.current,
    trial: status.trial?.id ?? null, upload: status.upload?.id ?? null, install: status.install?.state ?? null,
  })
  if (retryBaseline?.id === ctx.mine && retryBaseline.at === undefined) {
    retryBaseline.at = status.failed.find((f) => f.id === ctx.mine)?.at ?? null
  }
  if (!status.accepts) {
    setView(gen, { state: 'box_off', mine: ctx.mine, theirs: ctx.theirs, message: status.refusal ?? 'turned_off_on_box' })
    return
  }
  if (status.running.id === ctx.mine && (!status.running.trial || status.current === ctx.mine)) {
    retryBaseline = null
    setView(gen, { state: 'current', mine: ctx.mine, theirs: ctx.theirs })
    return
  }
  const boxGaveUp = boxFailure(status, ctx.mine)
  if (boxGaveUp) { failed(ctx, boxGaveUp.why, true); return }
  const mineGaveUp = (await readGaveUp())[ctx.mine]
  if (mineGaveUp) {
    setView(gen, { state: 'failed', mine: ctx.mine, theirs: ctx.theirs, message: mineGaveUp.why })
    return
  }
  await update(ctx, status)
}

async function update(ctx: Ctx, status: BoxBuildStatus): Promise<void> {
  const { mine } = ctx
  const retrying = retryBaseline?.id === mine
  const install = status.install?.id === mine ? status.install : null
  const activate = status.activate?.id === mine ? status.activate : null
  // A failure the box recorded before a Retry is the one the Retry is for.
  if (!retrying && install?.state === 'failed') { failed(ctx, install.message || 'the install failed', true, install.logTail); return }
  if (!retrying && activate?.state === 'failed') { failed(ctx, activate.message || 'the new build did not start', true); return }

  // Resume from where the box stands.
  if (status.running.id === mine || status.trial?.id === mine || (activate && activate.state !== 'failed')) { await waitForStart(ctx); return }
  if (install?.state === 'ready') { if (await activateStep(ctx) !== 'end') await waitForStart(ctx); return }
  if (install?.state === 'running') { if (await waitForInstall(ctx) === 'ready' && await activateStep(ctx) !== 'end') await waitForStart(ctx); return }

  setView(ctx.gen, { state: 'updating', mine, theirs: ctx.theirs, step: 'uploading', progress: 0 })
  let pkg: CompanionAppPackage
  try {
    pkg = await buildCompanionAppPackage({ platform: status.platform, arch: status.arch })
  } catch (err) {
    failed(ctx, err instanceof Error ? err.message : String(err), true)
    return
  }
  if (!live(ctx)) return
  if (pkg.id !== mine) { paused(ctx, 'uploading', `the package names build ${pkg.id}, not ${mine}`); return }
  const uploaded = status.upload?.id === mine && status.upload.complete && status.upload.size === pkg.tgz.length
  if (!uploaded && await upload(ctx, pkg, status) === 'end') return
  const installed = await installStep(ctx, pkg)
  if (installed === 'end') return
  if (installed !== 'ready' && await waitForInstall(ctx) !== 'ready') return
  if (await activateStep(ctx) === 'end') return
  await waitForStart(ctx)
}

async function upload(ctx: Ctx, pkg: CompanionAppPackage, status: BoxBuildStatus): Promise<'done' | End> {
  const size = pkg.tgz.length
  const sha = await sha256Of(pkg.id, pkg.tgz)
  const part = status.upload
  let offset = part && part.id === ctx.mine && !part.complete && part.size === size && part.received < size ? part.received : 0
  let mismatches = 0
  log.session.info('companion build: uploading', { id: ctx.mine, size, from: offset })
  for (;;) {
    if (!live(ctx)) return 'end'
    const progress = offset / size
    setView(ctx.gen, { state: 'updating', mine: ctx.mine, theirs: ctx.theirs, step: 'uploading', progress })
    const end = Math.min(offset + chunkBytes(), size)
    const query = `?id=${encodeURIComponent(ctx.mine)}&offset=${offset}&size=${size}&sha256=${sha}`
    let r: Reply
    // A long upload from the Mac now and then loses its connection mid-chunk.
    // The same chunk again is safe: a box that kept it answers offset_mismatch
    // with where it stands.
    for (let attempt = 0; ; attempt++) {
      try {
        r = await call(ctx.ep, 'PUT', `/package${query}`, pkg.tgz.subarray(offset, end), CHUNK_TIMEOUT_MS)
        break
      } catch (err) {
        const why = requestError(err)
        if (attempt >= CHUNK_RETRY_WAITS.length || !live(ctx)) return paused(ctx, 'uploading', why, progress)
        log.session.info('companion build: chunk failed, sending it again', { id: ctx.mine, offset, attempt: attempt + 1, why })
        await sleep(CHUNK_RETRY_WAITS[attempt]! * retryScale())
      }
    }
    const refusal = doorRefusal(r)
    if (refusal) return refused(ctx, refusal, r.status)
    const reply = r.json as Partial<UploadReply> | null
    if (!reply || typeof reply.ok !== 'boolean') return paused(ctx, 'uploading', `HTTP ${r.status}`, progress)
    if (reply.error === 'offset_mismatch' && typeof reply.received === 'number') {
      if (++mismatches > MAX_OFFSET_MISMATCHES) return paused(ctx, 'uploading', 'the companion kept losing its place in the upload', progress)
      log.session.info('companion build: upload offset moved', { id: ctx.mine, sent: offset, box: reply.received })
      offset = reply.received >= 0 && reply.received < size ? reply.received : 0
      continue
    }
    if (!reply.ok) return stepRefused(ctx, 'uploading', reply)
    if (reply.complete) {
      log.session.info('companion build: uploaded', { id: ctx.mine, size })
      return 'done'
    }
    if (typeof reply.received !== 'number' || reply.received >= size) return paused(ctx, 'uploading', 'the companion did not take the whole package', progress)
    offset = reply.received
  }
}

/** 'ready': the box answered that the step's result is already there (an install of this build it kept). */
async function postStep(ctx: Ctx, step: 'installing' | 'starting', sub: string, body: unknown): Promise<'ok' | 'ready' | End> {
  setView(ctx.gen, { state: 'updating', mine: ctx.mine, theirs: ctx.theirs, step })
  let r: Reply
  try {
    r = await call(ctx.ep, 'POST', sub, JSON.stringify(body), STEP_TIMEOUT_MS)
  } catch (err) {
    return paused(ctx, step, requestError(err))
  }
  const refusal = doorRefusal(r)
  if (refusal) return refused(ctx, refusal, r.status)
  const reply = r.json as Partial<StepReply> | null
  if (!reply || typeof reply.ok !== 'boolean') return paused(ctx, step, `HTTP ${r.status}`)
  if (!reply.ok) return stepRefused(ctx, step, reply)
  log.session.info(`companion build: ${step === 'installing' ? 'install' : 'activate'} started`, { id: ctx.mine, state: reply.state ?? null })
  return reply.state === 'ready' ? 'ready' : 'ok'
}

function installStep(ctx: Ctx, pkg: CompanionAppPackage): Promise<'ok' | 'ready' | End> {
  const body: InstallRequest = {
    id: ctx.mine,
    depsHash: pkg.companionDepsHash,
    dependencies: pkg.dependencies,
    optionalDependencies: pkg.optionalDependencies,
    appPackageJson: pkg.appPackageJson,
  }
  return postStep(ctx, 'installing', '/install', body)
}

function activateStep(ctx: Ctx): Promise<'ok' | 'ready' | End> {
  return postStep(ctx, 'starting', '/activate', { id: ctx.mine })
}

/**
 * Poll the status until `done` says what it shows, or the deadline. A status
 * read that fails is skipped: the box restarts itself while it activates.
 */
async function poll(ctx: Ctx, step: 'installing' | 'starting', deadlineMs: number, done: (s: BoxBuildStatus) => 'wait' | 'ready' | End): Promise<'ready' | End> {
  const deadline = Date.now() + deadlineMs
  setView(ctx.gen, { state: 'updating', mine: ctx.mine, theirs: ctx.theirs, step })
  while (Date.now() < deadline) {
    await sleep(pollMs())
    if (!live(ctx)) return 'end'
    const l = await look(ctx.ep, STATUS_TIMEOUT_MS)
    if (!live(ctx)) return 'end'
    if (l.kind === 'refused') return refused(ctx, l.kind, l.httpStatus)
    if (l.kind !== 'ok') continue
    ctx.theirs = l.status.running.id
    const answer = done(l.status)
    if (answer !== 'wait') return answer
  }
  return failed(ctx, step === 'installing'
    ? `the install did not finish within ${Math.round(deadlineMs / 60_000)} minutes`
    : `the new build did not start within ${Math.round(deadlineMs / 60_000)} minutes`, false)
}

function waitForInstall(ctx: Ctx): Promise<'ready' | End> {
  return poll(ctx, 'installing', INSTALL_DEADLINE_MS, (s) => {
    const gaveUp = boxFailure(s, ctx.mine)
    if (gaveUp) return failed(ctx, gaveUp.why, true)
    const inst = s.install
    if (inst?.id !== ctx.mine || inst.state === 'absent') return paused(ctx, 'installing', 'the companion has no install of this build; it starts again at the next check')
    if (inst.state === 'ready') { log.session.info('companion build: installed', { id: ctx.mine }); return 'ready' }
    if (inst.state === 'failed') return failed(ctx, inst.message || 'the install failed', true, inst.logTail)
    return 'wait'
  })
}

async function waitForStart(ctx: Ctx): Promise<void> {
  await poll(ctx, 'starting', ACTIVATE_DEADLINE_MS, (s) => {
    if (s.running.id === ctx.mine && s.current === ctx.mine) {
      retryBaseline = null
      log.session.info('companion build: the companion runs this build', { id: ctx.mine })
      setView(ctx.gen, { state: 'current', mine: ctx.mine, theirs: ctx.mine })
      return 'end'
    }
    const gaveUp = boxFailure(s, ctx.mine)
    if (gaveUp) return failed(ctx, gaveUp.why, true)
    if (s.activate?.id === ctx.mine && s.activate.state === 'failed') return failed(ctx, s.activate.message || 'the new build did not start', true)
    return 'wait'
  })
}

// --- entry points -------------------------------------------------------------

/** Look at the companion and bring it to this Mac's build. Single flight; never rejects. */
export function tickCompanionBuild(reason: string): Promise<void> {
  const automatic = reason !== 'retry' && reason !== 'settings'
  if (automatic) {
    if (!automaticTicksAllowed()) return Promise.resolve()
    // Not before the process is a minute old: one deferred tick for every early caller.
    const wait = bootDelayMs() - process.uptime() * 1000
    if (wait > 0) {
      deferred ??= new Promise<void>((resolve) => { setTimeout(resolve, wait).unref?.() })
        .then(() => { deferred = null; return tickCompanionBuild(reason) })
      return deferred
    }
  }
  if (inFlight && inFlightGen === generation) return inFlight
  const gen = generation
  const before = inFlight
  const run: Promise<void> = (async () => {
    if (before) await before // a stopped flow ends at its next step
    await runFlow(reason, gen)
    await gaveUpRecord.settled() // what this flow gave up on is on disk before the tick ends
  })().catch((err) => {
    log.session.warn('companion build: tick failed', { reason, error: err instanceof Error ? err.message : String(err) })
  }).finally(() => { if (inFlight === run) inFlight = null })
  inFlight = run
  inFlightGen = gen
  return run
}

/** Retry: forget that this Mac gave up on its own build, then look again now. */
export async function retryCompanionBuild(): Promise<void> {
  if (myId === undefined) myId = await runningBuildId().catch(() => null)
  const mine = myId
  if (mine) {
    if ((await readGaveUp())[mine]) await writeGaveUp((map) => { delete map[mine] })
    retryBaseline = { id: mine, at: undefined }
  }
  restUntil = 0
  log.session.info('companion build: retry', { id: mine })
  setView(generation, { state: 'checking', mine, theirs: view.theirs })
  void tickCompanionBuild('retry')
}

/** `cloud_bridge.auto_update` was just written: stop now, or look now. */
export function companionAutoUpdateChanged(on: boolean): CompanionBuildView {
  if (!on) {
    generation++ // a flow in progress stops writing and ends at its next step
    setView(generation, { state: 'off', autoUpdate: false })
  } else {
    restUntil = 0
    if (view.state === 'off') setView(generation, { state: 'checking', autoUpdate: true })
    else view = { ...view, autoUpdate: true, at: Date.now() }
    void tickCompanionBuild('settings')
  }
  return companionBuildView()
}

/**
 * The view, with the cheap gates read again (config, pairing): what GET answers.
 * A gate that opened (updates turned on in config.yaml, a companion paired) starts a look.
 */
export async function refreshCompanionBuildView(timeoutMs = 3_000): Promise<CompanionBuildView> {
  let t: ReturnType<typeof setTimeout> | undefined
  try {
    const g = await Promise.race([gate(), new Promise<null>((resolve) => { t = setTimeout(() => resolve(null), timeoutMs) })])
    if (!g) return companionBuildView()
    if (!g.open) {
      // A gate that closed for a moment (an endpoint lookup that missed) does not
      // override a flow in progress; updates turned off always do.
      if (view.state !== g.state && (!inFlight || !g.autoUpdate)) {
        if (!g.autoUpdate) generation++
        setView(generation, { state: g.state, mine: g.mine, autoUpdate: g.autoUpdate, ...(g.message ? { message: g.message } : {}) })
      }
    } else if (!inFlight && (view.state === 'off' || view.state === 'no_companion' || view.mine !== g.mine)) {
      setView(generation, { state: 'checking', mine: g.mine, autoUpdate: true })
      void tickCompanionBuild('settings')
    }
  } catch { /* the last view stands */ } finally {
    clearTimeout(t)
  }
  return companionBuildView()
}

/** Tests only. */
export async function _resetCompanionBuildForTesting(): Promise<void> {
  generation++
  await inFlight?.catch(() => {})
  await gaveUpRecord.settled()
  view = { state: 'checking', mine: null, theirs: null, autoUpdate: true, at: Date.now() }
  inFlight = null
  inFlightGen = -1
  deferred = null
  restUntil = 0
  myId = undefined
  retryBaseline = null
  gaveUpRecord.forget()
  shaCache = null
  shaMismatches = null
}
