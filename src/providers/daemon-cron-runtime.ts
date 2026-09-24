import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { CronSupervisionController, DaemonSessionGate } from './daemon-cron-controller.js'
import { CronSupervisionStore } from './daemon-cron-store.js'
import { createCronObserver, supportsCronRestore } from './daemon-cron-observer.js'
import { cliEnvTrue, findCronTranscript, probeCronProcess, readCronBootId, readCronCliConfig, readCronCliVersion } from './daemon-cron-host.js'
import { readCronTranscript } from './daemon-cron-transcript.js'
import { buildCronResumeArgs, createCronSupervision, type CronLaunchSpec, type CronProcessIdentity, type CronSupervisionRecord } from './daemon-cron-supervision.js'

export { DaemonSessionGate, readCronBootId, readCronCliConfig }
export { processStartedAtMs } from './daemon-cron-host.js'
export { cliOneShotTime, nextCliCronMinute } from './daemon-cron-schedule.js'
export { readCronMetadataStream, CRON_PROMPT_LIMIT } from './daemon-cron-metadata.js'
export { spawnBehindRegistry } from './daemon-spawn-barrier.js'
export { prepareDaemonServiceHandover, consumeDaemonServiceHandover } from './daemon-service-handover.js'

export async function persistCronHooks(stateDir: string, config: unknown): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(stateDir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)
    || (process.getuid && stat.uid !== process.getuid())) throw new Error('Daemon hook directory is not private')
  const target = path.join(stateDir, 'hooks.json')
  const temporary = `${target}.${randomUUID()}.tmp`
  const file = await fs.open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(config) + '\n')
    await file.sync()
  } finally { await file.close() }
  await fs.rename(temporary, target)
  const directory = await fs.open(stateDir, 'r')
  try { await directory.sync() } finally { await directory.close() }
}

export interface CronRuntimeSession {
  sid: string
  pid: number | null
  startTime: string | null
  bootId?: string
  cwd: string
  args: string[]
  mode: string
  cliVersion?: string
  cronCandidate: boolean
}

export interface CronRuntimeOptions {
  stateDir: string
  home: string
  platform: string
  env: NodeJS.ProcessEnv
  gate: DaemonSessionGate
  sessions(): CronRuntimeSession[]
  hooksHash(): string | null | undefined
  start(sid: string, launch: CronLaunchSpec, isCurrent: () => boolean): Promise<{ pid: number; startTime: string | null }>
  changed(record: CronSupervisionRecord): void
  error(error: unknown): void
}

export async function createDaemonCronRuntime(options: CronRuntimeOptions) {
  const store = new CronSupervisionStore(path.join(options.stateDir, 'supervision'))
  await store.load()
  const bootId = await readCronBootId(options.platform, AbortSignal.timeout(5000))
  if (!bootId) throw new Error('Host boot identity is unavailable')
  let stopped = false
  let pauseToken: object | null = null
  let pending: Promise<void> | null = null
  const pendingStops = new Map<string, string>()
  const claudeHome = options.env.CLAUDE_CONFIG_DIR ?? path.join(options.home, '.claude')
  const observer = createCronObserver({
    bootId,
    process: async (record, signal) => {
      const current = options.sessions().find((session) => session.sid === record.sid)
      if (current?.pid && current.pid !== record.process?.pid) return { status: 'unknown' }
      return probeCronProcess(record.process, bootId, options.platform, signal)
    },
    cliVersion: (launch, signal) => readCronCliVersion(launch.args[0], signal),
    config: (signal) => readCronCliConfig(options.home, options.env, signal),
    transcript: async (record, signal) => {
      const file = await findCronTranscript(record.sid, record.launch!.cwd, claudeHome, signal)
      return readCronTranscript(file, signal, cliEnvTrue(options.env.CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP))
    },
    launchBlocker: async (launch) => {
      if (!(await fs.stat(launch.cwd)).isDirectory()) return 'cwd-unavailable'
      const hooks = options.hooksHash()
      if (hooks === undefined || launch.hooksHash !== hooks) return 'hooks-unavailable'
      try { buildCronResumeArgs(launch.args, '00000000-0000-4000-8000-000000000000') }
      catch { return 'unsupported-launch-arguments' }
      return null
    },
  })
  const controller = new CronSupervisionController({
    store, gate: options.gate, observe: observer, changed: options.changed,
    ensureRunning: async (sid, launch, isCurrent) => {
      const current = () => !stopped && isCurrent()
      if (!current()) return null
      if (options.hooksHash() === undefined || options.hooksHash() !== launch.hooksHash) throw new Error('Recovery hook policy changed')
      const result = await options.start(sid, { ...launch, args: buildCronResumeArgs(launch.args, sid) }, current)
      if (!result.startTime) throw new Error('Resumed process identity is unavailable')
      return { bootId, pid: result.pid, startTime: result.startTime }
    },
  })

  async function reconcile() {
    for (const session of options.sessions()) {
      if (stopped || pauseToken) return
      if (!session.cronCandidate || !session.pid || !session.startTime || !session.cwd || !session.args.length) continue
      const existing = store.get(session.sid)
      if (existing && !existing.enabled) continue
      const version = session.cliVersion ?? existing?.launch?.cliVersion
      if (!version || !supportsCronRestore(version)) continue
      if (!session.bootId) continue
      const identity: CronProcessIdentity = { bootId: session.bootId, pid: session.pid, startTime: session.startTime }
      const probe = await probeCronProcess(identity, bootId, options.platform, AbortSignal.timeout(5000))
      if (probe.status === 'unknown' || stopped) continue
      const hooksHash = options.hooksHash()
      if (hooksHash === undefined || (hooksHash === null && existing?.launch?.hooksHash)) continue
      const launch = { cwd: session.cwd, args: session.args, mode: session.mode, cliVersion: version, hooksHash }
      if (!existing) {
        const candidate = createCronSupervision(session.sid, launch, Date.now())
        candidate.process = identity
        const evidence = await observer(candidate)
        if (evidence.cron !== 'active' || evidence.process === 'unknown' || evidence.blockedReason || stopped) continue
      }
      await options.gate.run(session.sid, async () => {
        const latest = options.sessions().find((entry) => entry.sid === session.sid)
        if (stopped || latest?.pid !== session.pid || latest.startTime !== session.startTime || latest.bootId !== session.bootId) return
        await controller.register(session.sid, launch, identity)
      })
    }
    if (!stopped) await controller.tick()
  }

  const tick = () => {
    if (stopped || pauseToken) return Promise.resolve()
    if (pending) return pending
    pending = reconcile().finally(() => { pending = null })
    return pending
  }
  const timer = setInterval(() => { void tick().catch(options.error) }, 30_000)
  timer.unref()
  return {
    tick,
    get: (sid: string) => store.get(sid),
    list: () => store.list(),
    deliveryAllowed: (sid: string, stopFence: unknown) => {
      const stoppedAt = pendingStops.get(sid) ?? store.get(sid)?.stopRequestId
      return !stoppedAt || stoppedAt === stopFence
    },
    disable: async (sid: string, stopRequestId?: string) => {
      if (stopRequestId) pendingStops.set(sid, stopRequestId)
      await controller.disable(sid, stopRequestId)
      if (stopRequestId && pendingStops.get(sid) === stopRequestId) pendingStops.delete(sid)
    },
    enable: (sid: string, stopFence?: unknown) => controller.enable(sid, stopFence),
    pause: () => {
      if (stopped || pauseToken) throw new Error('Cron recovery is already stopping')
      const recovery = controller.pause()
      const token = pauseToken = {}
      return {
        drained: Promise.allSettled([recovery.drained, pending]).then((results) => {
          const failed = results.find((result) => result.status === 'rejected')
          if (failed?.status === 'rejected') throw failed.reason
        }),
        resume: () => {
          if (pauseToken !== token) return
          pauseToken = null
          recovery.resume()
        },
      }
    },
    close: async () => {
      stopped = true
      clearInterval(timer)
      const drained = await Promise.allSettled([controller.close(), pending])
      const failed = drained.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    },
  }
}
