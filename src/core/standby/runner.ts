/**
 * The periodic standby batch, run only while the experiment `switchable_leader` is on, on
 * the leader, with `standby.dir` set in config.yaml.
 *
 * Off (the default), nothing runs: no timer, no write gate, no file written. This supervisor
 * reads the setting at start and at every `config:changed` (as topics-runtime.ts does) and
 * starts or stops the loop. While on, it opens the write gate (src/utils/write-gate.ts), takes
 * a batch every `standby.interval_seconds` (30), retries a void one soon after (a void batch
 * only means something changed at the wrong instant), runs a verify pass after each batch,
 * and sends to Walnut Health (never to the person): a drift report, once; a standby that
 * fell more than five minutes behind, once per episode.
 */
import path from 'node:path'
import { log } from '../../logging/index.js'
import { setWriteGateEnabled } from '../../utils/write-gate.js'
import { snapshotTo, standbyStatus, verifyStandby, type BatchOutcome, type DriftReport } from './index.js'

const SUBSCRIBER = 'standby-runner'
const BEHIND_MS = 5 * 60_000
const RETRY_MS = 2_000
const RETRIES = 3

export interface StandbySettings {
  on: boolean
  home: string
  dir?: string
  intervalSeconds: number
}

export interface StandbyRunnerDeps {
  settings(): Promise<StandbySettings>
  /** Walnut Health (no needsYou): the server's publishErrorNotification. */
  notify(n: { title: string; body: string; dedupScope: string; recoveryKey?: string }): Promise<boolean>
  /** The standby caught up after it was reported behind. */
  onRecovered?(): void
}

export async function defaultStandbyDeps(): Promise<StandbyRunnerDeps> {
  return {
    async settings() {
      const [{ getConfig }, { experimentalEnabled }, { isFollower }, { WALNUT_HOME }] = await Promise.all([
        import('../config-manager.js'), import('../experimental.js'), import('../server-role.js'), import('../../constants.js'),
      ])
      const config = await getConfig()
      const raw = Number(config.standby?.interval_seconds)
      return {
        on: !isFollower() && experimentalEnabled(config.experimental, 'switchable_leader'),
        home: WALNUT_HOME,
        dir: config.standby?.dir,
        intervalSeconds: Number.isFinite(raw) && raw >= 5 ? raw : 30,
      }
    },
    notify: async () => false,
  }
}

export interface StandbyRunner {
  stop(): void
  reconcile(): Promise<void>
  running(): boolean
  /** Take one batch now (with its retries and verify pass); resolves with the last outcome. */
  runOnce(): Promise<BatchOutcome | null>
}

export function startStandbyRunner(deps?: StandbyRunnerDeps): StandbyRunner {
  let stopped = false
  let live: { stop: () => void; runOnce: () => Promise<BatchOutcome | null> } | null = null
  let liveKey = ''
  let chain: Promise<void> = Promise.resolve()
  const depsReady = deps ? Promise.resolve(deps) : defaultStandbyDeps()

  const start = (d: StandbyRunnerDeps, s: StandbySettings & { dir: string }) => {
    setWriteGateEnabled(true)
    let timer: ReturnType<typeof setTimeout> | null = null
    let running: Promise<BatchOutcome | null> | null = null
    let ended = false
    let behindTold = false
    const report = (r: DriftReport) => d.notify({
      title: 'Standby copy: files changed there directly',
      body: `The standby copy at ${s.dir} had ${r.items.length} path(s) changed in it directly; each was saved under drift/ and the copy put back to batch ${r.batch}: ${r.items.slice(0, 5).map((i) => `${i.p} (${i.kind})`).join(', ')}`,
      dedupScope: `standby-drift:${r.at}`,
    })
    const once = async (): Promise<BatchOutcome | null> => {
      let out: BatchOutcome | null = null
      for (let attempt = 0; attempt <= RETRIES && !ended; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, RETRY_MS))
        out = await snapshotTo(s.home, s.dir).catch((err) => ({ ok: false as const, reason: String(err), stats: {} as never }))
        if (out.ok) break
        log.session.info('standby: batch void', { reason: out.reason, attempt })
      }
      await verifyStandby(s.dir, { report }).catch((err) => log.session.warn('standby: verify failed', { error: String(err) }))
      const status = await standbyStatus(s.dir).catch(() => null)
      const behind = !status?.takenAt || Date.now() - Date.parse(status.takenAt) > BEHIND_MS
      if (behind && !behindTold) {
        behindTold = await d.notify({
          title: 'Standby copy is behind',
          body: `The standby copy at ${s.dir} holds ${status?.takenAt ? `batch ${status.batch}, taken at ${status.takenAt}` : 'no complete batch yet'}. Last attempt: ${out && !out.ok ? out.reason : 'ok'}`,
          dedupScope: 'standby-behind',
          recoveryKey: 'standby',
        })
      } else if (!behind && behindTold) {
        behindTold = false
        d.onRecovered?.()
      }
      return out
    }
    const runOnce = (): Promise<BatchOutcome | null> => {
      running ??= once().finally(() => { running = null })
      return running
    }
    const loop = () => {
      timer = setTimeout(() => { void runOnce().finally(() => { if (!ended) loop() }) }, s.intervalSeconds * 1000)
      timer.unref?.()
    }
    void runOnce().finally(() => { if (!ended) loop() })
    return {
      runOnce,
      stop: () => {
        ended = true
        if (timer) clearTimeout(timer)
        setWriteGateEnabled(false)
      },
    }
  }

  const reconcile = (): Promise<void> => {
    chain = chain.then(async () => {
      const d = await depsReady
      if (stopped) return
      const s = await d.settings().catch(() => null)
      const want = s?.on && s.dir ? `${path.resolve(s.dir)}|${s.home}|${s.intervalSeconds}` : ''
      if (want === liveKey) return
      live?.stop()
      live = null
      liveKey = ''
      if (want && s?.dir) {
        live = start(d, { ...s, dir: path.resolve(s.dir) })
        liveKey = want
        log.session.info('standby: batches started (experiment on)', { dir: s.dir, intervalSeconds: s.intervalSeconds })
      } else if (s?.on) {
        log.session.info('standby: experiment on but standby.dir is not set; nothing runs')
      }
    }).catch((err) => log.session.warn('standby: start or stop failed', { error: err instanceof Error ? err.message : String(err) }))
    return chain
  }

  void reconcile()
  void import('../event-bus.js').then(({ bus }) => {
    if (stopped) return
    bus.subscribe(SUBSCRIBER, () => { void reconcile() }, { global: true, interest: ['config:changed'] })
  })

  return {
    reconcile,
    running: () => live !== null,
    runOnce: () => live ? live.runOnce() : Promise.resolve(null),
    stop() {
      stopped = true
      live?.stop()
      live = null
      void import('../event-bus.js').then(({ bus }) => bus.unsubscribe(SUBSCRIBER)).catch(() => {})
    },
  }
}
