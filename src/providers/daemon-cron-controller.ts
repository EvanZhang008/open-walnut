import type { CronSupervisionStore } from './daemon-cron-store.js'
import {
  beginCronRecovery,
  createCronSupervision,
  decideCronRecovery,
  disableCronSupervision,
  enableCronSupervision,
  type CronLaunchSpec,
  type CronProcessIdentity,
  type CronRecoveryEvidence,
  type CronSupervisionRecord,
} from './daemon-cron-supervision.js'

export class DaemonSessionGate {
  private readonly pending = new Map<string, Promise<unknown>>()

  async run<T>(sid: string, work: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(sid) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(work)
    this.pending.set(sid, next)
    try {
      return await next
    } finally {
      if (this.pending.get(sid) === next) this.pending.delete(sid)
    }
  }
}

export interface CronObservation extends CronRecoveryEvidence {
  identity?: CronProcessIdentity
  blockedReason?: string
}

export interface CronControllerDeps {
  store: CronSupervisionStore
  gate: DaemonSessionGate
  observe(record: CronSupervisionRecord): Promise<CronObservation>
  ensureRunning(
    sid: string,
    launch: CronLaunchSpec,
    isCurrent: () => boolean,
  ): Promise<CronProcessIdentity | null>
  changed(record: CronSupervisionRecord): void
  clock?: () => number
  random?: () => number
}

export class CronSupervisionController {
  private readonly stopped = new Set<string>()
  private readonly intentVersions = new Map<string, number>()
  private running: Promise<void> | null = null
  private closed = false
  private pauseToken: object | null = null
  private readonly now: () => number
  private readonly random: () => number

  constructor(private readonly deps: CronControllerDeps) {
    this.now = deps.clock ?? Date.now
    this.random = deps.random ?? Math.random
  }

  async register(sid: string, launch: CronLaunchSpec, process: CronProcessIdentity): Promise<void> {
    const record = await this.deps.store.update(sid, (current) => {
      if (this.stopped.has(sid) || (current && !current.enabled)) return null
      if (current && JSON.stringify(current.launch) === JSON.stringify(launch)
        && JSON.stringify(current.process) === JSON.stringify(process)) return null
      return { ...(current ?? createCronSupervision(sid, launch, this.now())), launch, process }
    })
    if (record) this.deps.changed(record)
  }

  async disable(sid: string, stopRequestId?: string): Promise<void> {
    this.intentVersions.set(sid, (this.intentVersions.get(sid) ?? 0) + 1)
    this.stopped.add(sid)
    const record = await this.deps.store.update(sid, (current) => ({
      ...disableCronSupervision(current ?? {
        sid, generation: 0, enabled: false, state: 'disabled', launch: null,
        process: null, attempts: [], retryAt: null, reason: null, updatedAt: this.now(),
      }, this.now()),
      ...(stopRequestId ? { stopRequestId } : {}),
    }))
    if (record) this.deps.changed(record)
  }

  async enable(sid: string, stopFence?: unknown): Promise<void> {
    const intent = (this.intentVersions.get(sid) ?? 0) + 1
    this.intentVersions.set(sid, intent)
    await this.deps.gate.run(sid, async () => {
      const record = await this.deps.store.update(sid, (current) => {
        if (this.intentVersions.get(sid) !== intent) throw new Error('Supervision request was superseded')
        if (current?.stopRequestId && current.stopRequestId !== stopFence) throw new Error('Supervision request was superseded by a stop')
        if (!current?.launch) throw new Error('No saved launch settings for this session')
        return enableCronSupervision(current, this.now())
      })
      if (this.intentVersions.get(sid) !== intent) throw new Error('Supervision request was superseded')
      this.stopped.delete(sid)
      if (record) this.deps.changed(record)
    })
  }

  pause() {
    if (this.closed || this.pauseToken) throw new Error('Cron recovery is already stopping')
    const token = this.pauseToken = {}
    return {
      drained: this.running ?? Promise.resolve(),
      resume: () => { if (this.pauseToken === token) this.pauseToken = null },
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await this.running
  }

  tick(): Promise<void> {
    if (this.closed || this.pauseToken) return Promise.resolve()
    if (this.running) return this.running
    const work = this.reconcileAll()
    this.running = work
    void work.finally(() => { if (this.running === work) this.running = null }).catch(() => {})
    return work
  }

  private async reconcileAll(): Promise<void> {
    for (const record of this.deps.store.list()) {
      if (this.closed || this.pauseToken) return
      if (!record.enabled || this.stopped.has(record.sid)) continue
      await this.deps.gate.run(record.sid, () => this.reconcileOne(record.sid))
    }
  }

  private async reconcileOne(sid: string): Promise<void> {
    const initial = this.deps.store.get(sid)
    if (this.closed || !initial?.enabled || this.stopped.has(sid)) return
    const generation = initial.generation
    const isCurrent = () => {
      if (this.closed || this.stopped.has(sid)) return false
      const current = this.deps.store.get(sid)
      return current?.enabled === true && current.generation === generation
    }
    let evidence: CronObservation
    try {
      evidence = await this.deps.observe(initial)
    } catch {
      evidence = { process: 'unknown', cron: 'unknown' }
    }
    if (!isCurrent()) return
    const current = this.deps.store.get(sid)!
    const decision = evidence.blockedReason
      ? { action: 'none' as const, state: 'blocked' as const, reason: evidence.blockedReason }
      : decideCronRecovery(current, evidence, this.now())
    if (decision.action === 'none') {
      if (current.state === decision.state && current.reason === decision.reason && current.retryAt === null) return
      const record = await this.deps.store.update(sid, (latest) => {
        if (!isCurrent()) return null
        return {
          ...latest!, state: decision.state, reason: decision.reason, retryAt: null,
          ...(evidence.identity ? { process: evidence.identity } : {}), updatedAt: this.now(),
        }
      })
      if (record) this.deps.changed(record)
      return
    }
    if (decision.action === 'wait') {
      if (current.retryAt !== null) return
      const record = await this.deps.store.update(sid, (latest) => {
        if (!isCurrent()) return null
        return {
          ...latest!, state: 'restarting', reason: 'retry-backoff', updatedAt: this.now(),
          retryAt: decision.until + Math.floor(Math.min(1, Math.max(0, this.random())) * 1000),
        }
      })
      if (record) this.deps.changed(record)
      return
    }
    const started = await this.deps.store.update(sid, (latest) => {
      if (!isCurrent()) return null
      return beginCronRecovery(latest!, generation, this.now())
    })
    if (!started || !isCurrent()) return
    this.deps.changed(started)
    let identity: CronProcessIdentity | null
    try {
      identity = await this.deps.ensureRunning(sid, started.launch!, isCurrent)
    } catch {
      if (!isCurrent()) return
      const failed = await this.deps.store.update(sid, (latest) => {
        if (!isCurrent()) return null
        return { ...latest!, state: 'checking', reason: 'launch-failed', updatedAt: this.now() }
      })
      if (failed) this.deps.changed(failed)
      return
    }
    if (!identity || !isCurrent()) return
    const record = await this.deps.store.update(sid, (latest) => {
      if (!isCurrent()) return null
      return {
        ...latest!, process: identity, state: 'checking',
        reason: 'scheduler-unconfirmed', updatedAt: this.now(),
      }
    })
    if (record) this.deps.changed(record)
  }
}
