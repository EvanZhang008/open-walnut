/**
 * The companion's side of the `/bridge/build` door
 * (docs/plan/walnut-companion-unified-replica.md, stage 1): it takes the Mac's
 * build in chunks, installs it with the host install script, boots it once in
 * isolation, and hands it to its launcher as a trial. The trial confirms itself
 * after it has run for a while.
 *
 *   R = WALNUT_COMPANION_ROOT, else ~/.open-walnut-host
 *   R/app/<id>/{dist,.ready}  R/deps/<hash>        the host install layout (host-server/install.ts)
 *   R/incoming/<id>.tgz(.part) .upload.json        the upload; .install.sh/.log, .pid, .smoke.log
 *   R/companion/{current,trial,attempts,previous,failed/<id>}   one line each, shared with the launcher
 *   R/companion/{install,activate}.json            this server's record of its last step
 *
 * Every step runs on the request path of the live server, so all I/O is async.
 */

import { execFile, spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { getBuildInfo } from '../../lib/build-info.js'
import { execNeedsBunBeBun } from '../../lib/runtime.js'
import { createSubsystemLogger } from '../../logging/index.js'
import { installScript, parseInstallState, stateScript, type InstallState } from '../host-server/install.js'
import { dirs, errText, exists, knobMs, readJson, readLine, rmFile, sha256File, sizeOf, writeAtomic, type Dirs } from './box-files.js'
import { smokeBoot } from './box-smoke.js'
import {
  BUILD_SCHEMA, MAX_CHUNK_BYTES, MAX_PACKAGE_BYTES, MIN_FREE_BYTES, SHA256_RE, buildIdOf, installRequestProblem, validBuildId,
  type BoxBuildStatus, type InstallRequest, type StepReply, type UploadReply,
} from './wire.js'

const log = createSubsystemLogger('companion-build')

// ── who this box is ────────────────────────────────────────────────────────

export function boxAcceptance(env: NodeJS.ProcessEnv = process.env): Pick<BoxBuildStatus, 'accepts' | 'refusal'> {
  if (env.WALNUT_COMPANION_LAUNCHER !== '1') return { accepts: false, refusal: 'launcher_absent' }
  if (env.WALNUT_COMPANION_MAC_BUILDS !== '1') return { accepts: false, refusal: 'turned_off_on_box' }
  return { accepts: true }
}

export function runningBuild(env: NodeJS.ProcessEnv = process.env): BoxBuildStatus['running'] {
  const info = getBuildInfo()
  const launched = env.WALNUT_COMPANION_BUILD
  return {
    id: buildIdOf(info),
    version: info.version,
    commit: info.commit,
    base: !launched || launched === 'base',
    trial: env.WALNUT_COMPANION_TRIAL === '1',
  }
}

export interface BoxHooks {
  /** Hand the box back to its launcher (the default ends this process like systemd would). */
  restartSelf: () => void
  /** Free bytes where builds live, or null when unknown. */
  freeBytes: (dir: string) => Promise<number | null>
}

async function statfsFree(dir: string): Promise<number | null> {
  // The nearest existing parent: R itself may not exist yet.
  for (let d = dir; ; d = path.dirname(d)) {
    try {
      const s = await fsp.statfs(d)
      return Number(s.bavail) * Number(s.bsize)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(d) === d) return null
    }
  }
}

const defaultHooks: BoxHooks = {
  restartSelf: () => { if (process.pid > 1) process.kill(process.pid, 'SIGTERM') },
  freeBytes: statfsFree,
}
let hooks: BoxHooks = defaultHooks
export function _setBoxHooksForTesting(over: Partial<BoxHooks> | null): void {
  hooks = over ? { ...defaultHooks, ...over } : defaultHooks
}

// ── in-process state ───────────────────────────────────────────────────────

/** The activation this process runs (a smoke boot), if any. */
let activation: { id: string } | null = null
/** Every step that changes files runs one at a time (a Mac retry may overlap the first try). */
let chain: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

interface UploadMeta { id: string; size: number; sha256: string; at: number }
interface InstallRecord { id: string; at: number }
interface ActivateRecord { id: string; state: 'smoking' | 'restarting' | 'failed'; message?: string; at: number }

async function installState(id: string, R: string): Promise<InstallState> {
  const script = stateScript(id, R)
  return await new Promise((resolve, reject) => {
    // A failed install ends the script on `tail` of a log that may be missing: keep its output.
    execFile('sh', ['-c', script], { timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) reject(err)
      else resolve(parseInstallState(String(stdout)))
    })
  })
}

async function installRunning(d: Dirs): Promise<string | null> {
  const rec = await readJson<InstallRecord>(d.installRec)
  if (!rec || !validBuildId(rec.id)) return null
  const st = await installState(rec.id, d.R).catch(() => null)
  return st?.state === 'running' ? rec.id : null
}

// ── GET /bridge/build ──────────────────────────────────────────────────────

async function failedList(d: Dirs): Promise<BoxBuildStatus['failed']> {
  let names: string[]
  try {
    names = await fsp.readdir(d.failedDir)
  } catch {
    return []
  }
  const rows = await Promise.all(names.filter(validBuildId).map(async (id) => {
    const file = path.join(d.failedDir, id)
    try {
      const st = await fsp.stat(file)
      if (!st.isFile()) return null
      const why = ((await readLine(file)) ?? '').slice(0, 300)
      return { id, at: st.mtimeMs, why }
    } catch {
      return null
    }
  }))
  return rows.filter((r): r is NonNullable<typeof r> => r !== null).sort((a, b) => b.at - a.at).slice(0, 10)
    .map((r) => ({ ...r, at: Math.round(r.at) }))
}

async function uploadStatus(d: Dirs): Promise<BoxBuildStatus['upload']> {
  let names: string[]
  try {
    names = await fsp.readdir(d.incoming)
  } catch {
    return null
  }
  let best: UploadMeta | null = null
  for (const n of names.filter((x) => x.endsWith('.upload.json'))) {
    const m = await readJson<UploadMeta>(path.join(d.incoming, n))
    if (m && validBuildId(m.id) && (!best || m.at > best.at)) best = m
  }
  if (!best) return null
  const part = await sizeOf(d.part(best.id))
  if (part !== null) return { id: best.id, received: part, size: best.size, complete: false }
  if (await exists(d.tgz(best.id))) return { id: best.id, received: best.size, size: best.size, complete: true }
  return null
}

async function installStatus(d: Dirs): Promise<BoxBuildStatus['install']> {
  const rec = await readJson<InstallRecord>(d.installRec)
  if (!rec || !validBuildId(rec.id)) return null
  try {
    const st = await installState(rec.id, d.R)
    return st.state === 'failed' ? { id: rec.id, state: 'failed', message: st.message, logTail: st.logTail } : { id: rec.id, state: st.state }
  } catch (err) {
    return { id: rec.id, state: 'absent', message: `the install state could not be read: ${errText(err)}` }
  }
}

async function activateStatus(d: Dirs): Promise<BoxBuildStatus['activate']> {
  const rec = await readJson<ActivateRecord>(d.activateRec)
  if (!rec || !validBuildId(rec.id)) return null
  // 'smoking' that no activation of this process runs: the server ended in the middle of it.
  if (rec.state === 'smoking' && activation?.id !== rec.id) {
    return { id: rec.id, state: 'failed', message: 'the server restarted during the smoke boot', at: rec.at }
  }
  return { id: rec.id, state: rec.state, ...(rec.message ? { message: rec.message } : {}), at: rec.at }
}

export async function boxBuildStatus(): Promise<BoxBuildStatus> {
  const d = dirs()
  const [current, trialId, attempts, failed, upload, install, activate, freeBytes] = await Promise.all([
    readLine(d.current), readLine(d.trial), readLine(d.attempts), failedList(d), uploadStatus(d), installStatus(d), activateStatus(d),
    hooks.freeBytes(d.R).catch(() => null),
  ])
  const acceptance = boxAcceptance()
  const tries = Number(attempts)
  return {
    ok: true,
    schema: BUILD_SCHEMA,
    ...acceptance,
    running: runningBuild(),
    current: validBuildId(current) ? current : null,
    trial: validBuildId(trialId) ? { id: trialId, attempts: Number.isInteger(tries) && tries > 0 ? tries : 0 } : null,
    failed,
    upload,
    install,
    activate,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    freeBytes,
  }
}

// ── PUT /bridge/build/package ──────────────────────────────────────────────

export interface ChunkParams { id: string; offset: number; size: number; sha256: string }

function uploadError(p: ChunkParams, error: NonNullable<UploadReply['error']>, message: string, received = 0): UploadReply {
  return { ok: false, received, size: Number.isSafeInteger(p.size) ? p.size : 0, complete: false, error, message }
}

export async function putPackageChunk(p: ChunkParams, bytes: Buffer): Promise<UploadReply> {
  if (!validBuildId(p.id)) return uploadError(p, 'bad_request', 'id is not a build id')
  if (typeof p.sha256 !== 'string' || !SHA256_RE.test(p.sha256)) return uploadError(p, 'bad_request', 'sha256 is not a sha256 in hex')
  if (!Number.isSafeInteger(p.offset) || p.offset < 0 || !Number.isSafeInteger(p.size) || p.size <= 0) {
    return uploadError(p, 'bad_request', 'offset and size must be whole numbers, size above 0')
  }
  if (p.size > MAX_PACKAGE_BYTES) return uploadError(p, 'too_large', `a package is at most ${MAX_PACKAGE_BYTES} bytes`)
  if (bytes.length > MAX_CHUNK_BYTES) return uploadError(p, 'too_large', `a chunk is at most ${MAX_CHUNK_BYTES} bytes`)
  if (bytes.length === 0) return uploadError(p, 'bad_request', 'the chunk is empty')
  if (p.offset + bytes.length > p.size) return uploadError(p, 'bad_request', 'the chunk runs past the size')
  const acceptance = boxAcceptance()
  if (!acceptance.accepts) return uploadError(p, 'refused', `this box does not take builds (${acceptance.refusal})`)
  return serial(() => putChunkLocked(dirs(), p, bytes))
}

async function putChunkLocked(d: Dirs, p: ChunkParams, bytes: Buffer): Promise<UploadReply> {
  const meta = await readJson<UploadMeta>(d.meta(p.id))
  const same = !!meta && meta.id === p.id && meta.size === p.size && meta.sha256 === p.sha256
  if (same && ((await exists(d.tgz(p.id))) || (await exists(d.ready(p.id))))) {
    return { ok: true, received: p.size, size: p.size, complete: true }
  }
  if (p.offset === 0) {
    const installing = await installRunning(d)
    if (installing || activation) return uploadError(p, 'busy', `the ${installing ? `install of ${installing}` : `activation of ${activation!.id}`} is running`)
    const free = await hooks.freeBytes(d.R).catch(() => null)
    if (free !== null && free < MIN_FREE_BYTES) return uploadError(p, 'disk_full', `${free} bytes free, ${MIN_FREE_BYTES} needed`)
    await resetUploads(d, p.id)
    await writeAtomic(d.meta(p.id), JSON.stringify({ id: p.id, size: p.size, sha256: p.sha256, at: Date.now() } satisfies UploadMeta))
    await fsp.writeFile(d.part(p.id), bytes)
    log.info('package upload started', { id: p.id, size: p.size, sha256: p.sha256 })
  } else {
    const have = same ? await sizeOf(d.part(p.id)) : null
    if (have === null) return uploadError(p, 'offset_mismatch', 'no upload of this package is in progress: start at offset 0', 0)
    if (have !== p.offset) return uploadError(p, 'offset_mismatch', `the next chunk starts at ${have}`, have)
    await fsp.appendFile(d.part(p.id), bytes)
  }
  const received = p.offset + bytes.length
  if (received < p.size) return { ok: true, received, size: p.size, complete: false }
  const digest = await sha256File(d.part(p.id))
  if (digest !== p.sha256) {
    await rmFile(d.part(p.id))
    await rmFile(d.meta(p.id))
    log.warn('package upload: sha256 does not match, dropped', { id: p.id, expected: p.sha256, got: digest })
    return uploadError(p, 'sha_mismatch', 'the package does not match its sha256: upload it again from offset 0', 0)
  }
  await fsp.rename(d.part(p.id), d.tgz(p.id))
  log.info('package upload complete', { id: p.id, size: p.size })
  return { ok: true, received, size: p.size, complete: true }
}

/** One upload at a time: a new one drops every other upload and package not installed yet. */
async function resetUploads(d: Dirs, id: string): Promise<void> {
  await fsp.mkdir(d.incoming, { recursive: true })
  const names = await fsp.readdir(d.incoming)
  await Promise.all(names
    .filter((n) => n.endsWith('.tgz.part') || n.endsWith('.upload.json') || n.endsWith('.tgz'))
    .map((n) => rmFile(path.join(d.incoming, n))))
  await rmFile(d.tgz(id))
}

// ── POST /bridge/build/install ─────────────────────────────────────────────

/**
 * The install's environment: what bun's install needs (it reads npm's registry
 * settings too) and nothing else. The unit gives the server the box's secrets
 * (its EnvironmentFile), and the dependency install runs the lifecycle scripts
 * of the packages the build trusts.
 */
const INSTALL_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z]+|TMPDIR|TZ|(HTTPS?|NO)_PROXY|(https?|no)_proxy|npm_config_[A-Za-z_]+|NPM_CONFIG_[A-Z_]+|BUN_INSTALL[A-Z_]*|BUN_CONFIG_[A-Z_]+)$/
export function installEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && INSTALL_ENV.test(k)) env[k] = v
  return env
}

export async function startInstall(body: unknown): Promise<StepReply> {
  const problem = installRequestProblem(body)
  if (problem) return { ok: false, error: 'bad_request', message: problem }
  const acceptance = boxAcceptance()
  if (!acceptance.accepts) return { ok: false, error: 'refused', message: `this box does not take builds (${acceptance.refusal})` }
  return serial(() => startInstallLocked(dirs(), body as InstallRequest))
}

async function startInstallLocked(d: Dirs, req: InstallRequest): Promise<StepReply> {
  if (await exists(d.ready(req.id))) {
    await writeAtomic(d.installRec, JSON.stringify({ id: req.id, at: Date.now() } satisfies InstallRecord))
    return { ok: true, state: 'ready' }
  }
  const installing = await installRunning(d)
  if (installing === req.id) return { ok: true, state: 'running' }
  if (installing) return { ok: false, error: 'busy', message: `the install of ${installing} is running` }
  if (activation) return { ok: false, error: 'busy', message: `the activation of ${activation.id} is running` }
  if (!(await exists(d.tgz(req.id)))) return { ok: false, error: 'no_package', message: 'upload the package first' }
  const free = await hooks.freeBytes(d.R).catch(() => null)
  if (free !== null && free < MIN_FREE_BYTES) return { ok: false, error: 'disk_full', message: `${free} bytes free, ${MIN_FREE_BYTES} needed` }

  const [current, trial] = await Promise.all([readLine(d.current), readLine(d.trial)])
  const keep = [current, trial, runningBuild().id].filter(validBuildId)
  let script: string
  try {
    script = installScript({
      id: req.id, depsHash: req.depsHash, dependencies: req.dependencies, optionalDependencies: req.optionalDependencies,
      appPackageJson: req.appPackageJson, bun: { command: process.execPath, asBun: execNeedsBunBeBun() }, buildEnv: {}, root: d.R, keep,
    })
  } catch (err) {
    return { ok: false, error: 'refused', message: errText(err) }
  }
  const scriptFile = d.in(req.id, 'install.sh')
  await fsp.writeFile(scriptFile, script)
  await Promise.all([rmFile(d.in(req.id, 'failed')), rmFile(d.in(req.id, 'pid'))])
  // Detached and niced, its output in the install log: launchScript in install.ts, from this server.
  const out = await fsp.open(d.in(req.id, 'install.log'), 'w')
  let pid: number | undefined
  try {
    const child = spawn('nice', ['-n', '10', 'sh', scriptFile], { detached: true, stdio: ['ignore', out.fd, out.fd], env: installEnv() })
    child.once('error', (err) => {
      log.warn('install did not start', { id: req.id, error: err.message })
      void fsp.writeFile(d.in(req.id, 'failed'), `the install did not start: ${err.message}\n`).catch(() => {})
    })
    child.unref()
    pid = child.pid
  } finally {
    await out.close()
  }
  if (pid) await fsp.writeFile(d.in(req.id, 'pid'), `${pid}\n`)
  await writeAtomic(d.installRec, JSON.stringify({ id: req.id, at: Date.now() } satisfies InstallRecord))
  log.info('install started', { id: req.id, pid, depsHash: req.depsHash, keep })
  return { ok: true, state: 'running' }
}

// ── POST /bridge/build/activate ────────────────────────────────────────────

export async function startActivate(body: unknown): Promise<StepReply> {
  const id = (body as { id?: unknown } | null)?.id
  if (!validBuildId(id)) return { ok: false, error: 'bad_request', message: 'id is not a build id' }
  const acceptance = boxAcceptance()
  if (!acceptance.accepts) return { ok: false, error: 'refused', message: `this box does not take builds (${acceptance.refusal})` }
  return serial(() => startActivateLocked(dirs(), id))
}

async function startActivateLocked(d: Dirs, id: string): Promise<StepReply> {
  if (id === runningBuild().id) return { ok: true, state: 'running' }
  if (activation) {
    return activation.id === id ? { ok: true, state: 'smoking' } : { ok: false, error: 'busy', message: `the activation of ${activation.id} is running` }
  }
  const rec = await readJson<ActivateRecord>(d.activateRec)
  if (rec?.id === id && rec.state === 'restarting' && (await readLine(d.trial)) === id) return { ok: true, state: 'restarting' }
  if (!(await exists(d.ready(id)))) return { ok: false, error: 'not_installed', message: 'install the build first' }
  const installing = await installRunning(d)
  if (installing) return { ok: false, error: 'busy', message: `the install of ${installing} is running` }
  // Claim it before the record says 'smoking': a status read in between would call that record stale.
  activation = { id }
  try {
    await writeAtomic(d.activateRec, JSON.stringify({ id, state: 'smoking', at: Date.now() } satisfies ActivateRecord))
  } catch (err) {
    activation = null
    throw err
  }
  void runActivation(d, id).finally(() => { activation = null })
  return { ok: true, state: 'smoking' }
}

async function runActivation(d: Dirs, id: string): Promise<void> {
  log.info('smoke boot started', { id })
  try {
    const result = await smokeBoot({
      cli: path.join(d.app(id), 'dist', 'cli.js'),
      cwd: d.app(id),
      logFile: d.in(id, 'smoke.log'),
      timeoutMs: knobMs(process.env.WALNUT_COMPANION_SMOKE_MS, 150_000),
    })
    if (result.ok) {
      // A dist build runs only on the runtime it was tried on (the launcher reads this).
      await writeAtomic(d.runtime(id), `${smokeRuntime()}\n`)
      await writeAtomic(d.trial, `${id}\n`)
      await Promise.all([rmFile(d.attempts), rmFile(path.join(d.failedDir, id))])
      await writeAtomic(d.activateRec, JSON.stringify({ id, state: 'restarting', at: Date.now() } satisfies ActivateRecord))
      log.info('smoke boot passed: the launcher starts it as the trial', { id, ms: result.ms })
      setTimeout(() => {
        log.info('restarting into the trial', { id })
        hooks.restartSelf()
      }, 1_000).unref()
      return
    }
    await failActivation(d, id, result.reason ?? 'the smoke boot failed', result.logTail, result.ms)
  } catch (err) {
    await failActivation(d, id, `the smoke boot could not run: ${errText(err)}`, [], 0).catch(() => {})
  }
}

/** The runtime a smoke boot runs a build's dist/cli.js on: this server's own. */
export function smokeRuntime(versions: NodeJS.ProcessVersions = process.versions): 'bun' | 'node' {
  return typeof (versions as { bun?: string }).bun === 'string' ? 'bun' : 'node'
}

async function failActivation(d: Dirs, id: string, reason: string, tail: string[], ms: number): Promise<void> {
  const lines = tail.slice(-3).join(' | ')
  const message = lines ? `${reason}. Last lines: ${lines}` : reason
  await writeAtomic(d.activateRec, JSON.stringify({ id, state: 'failed', message, at: Date.now() } satisfies ActivateRecord))
  await writeAtomic(path.join(d.failedDir, id), `in a test start, ${reason}\n`)
  log.warn('smoke boot failed: the build is given up', { id, reason, ms })
}

// ── the trial confirms itself ──────────────────────────────────────────────

/**
 * In a trial (the launcher sets WALNUT_COMPANION_TRIAL=1): once the server has
 * run WALNUT_COMPANION_CONFIRM_MS (90 s), make it `current`. Resolves true when
 * it did; a box that is no trial, or whose trial file names another build by
 * then, changes nothing.
 */
export function startTrialConfirm(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (env.WALNUT_COMPANION_TRIAL !== '1') return Promise.resolve(false)
  // The id the launcher started (the directory name), else the build's own id.
  const launched = env.WALNUT_COMPANION_BUILD
  const id = launched && launched !== 'base' && validBuildId(launched) ? launched : runningBuild(env).id
  const ms = knobMs(env.WALNUT_COMPANION_CONFIRM_MS, 90_000)
  log.info('trial: confirms itself after it has run a while', { id, ms })
  return new Promise((resolve) => {
    setTimeout(() => {
      confirmTrial(dirs(), id).then(resolve, (err) => {
        log.warn('trial: confirm failed', { id, error: errText(err) })
        resolve(false)
      })
    }, ms).unref()
  })
}

async function confirmTrial(d: Dirs, id: string): Promise<boolean> {
  const trial = await readLine(d.trial)
  if (trial !== id) {
    log.info('trial: not confirmed, the trial file names another build', { id, trial })
    return false
  }
  const old = await readLine(d.current)
  if (old && old !== id) await writeAtomic(d.previous, `${old}\n`)
  await writeAtomic(d.current, `${id}\n`)
  await Promise.all([rmFile(d.trial), rmFile(d.attempts)])
  log.info('trial confirmed: it is the current build now', { id, previous: old })
  return true
}
