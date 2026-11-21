/**
 * The periodic standby batch, run only while the experiment `switchable_leader` is on, on
 * the leader, with `standby.dir` set in config.yaml: a folder on this machine, or one on the
 * host `standby.host` names (remote-transport.ts; the walnut program there is `standby.walnut`).
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
import { snapshotTo, standbyStatus, takeBatch, verifyStandby, type BatchOutcome, type DriftReport } from './index.js'
import { RemoteStandbyTarget, type DaemonLink } from './remote-transport.js'

const SUBSCRIBER = 'standby-runner'
const BEHIND_MS = 5 * 60_000
const RETRY_MS = 2_000
const RETRIES = 3

export interface StandbySettings {
  on: boolean
  home: string
  dir?: string
  /** The host the target folder is on (a host Walnut knows); none: this machine. */
  host?: string
  /** The walnut program on that host, as a program and its arguments. */
  walnut?: string[]
  intervalSeconds: number
}

export interface StandbyRunnerDeps {
  settings(): Promise<StandbySettings>
  /** Walnut Health (no needsYou): the server's publishErrorNotification. */
  notify(n: { title: string; body: string; dedupScope: string; recoveryKey?: string }): Promise<boolean>
  /** The standby caught up after it was reported behind. */
  onRecovered?(): void
  /** The link to a standby host's daemon (default: Walnut's own, src/core/hosts/link.ts). */
  connect?(host: string): Promise<DaemonLink>
  /** How long a dropped link to a standby host is waited for (default 2 min; tests shorten it). */
  linkWaitMs?: number
}

/** Where the batches go: a folder here, or one on a standby host. */
interface StandbySite {
  /** For messages: the folder, with its host in front when it is elsewhere. */
  label: string
  batch(): Promise<BatchOutcome>
  /** A verify pass after a batch; each drift report not yet handed on goes to `report` once. */
  verify(out: BatchOutcome | null, report: (r: DriftReport) => Promise<boolean>): Promise<void>
  current(): Promise<{ batch: number; takenAt: string } | null>
  /** The site's host stayed out of reach through the last call (a remote site only). */
  unreachable?(): boolean
}

function localSite(home: string, dir: string): StandbySite {
  return {
    label: dir,
    batch: () => snapshotTo(home, dir),
    verify: async (_out, report) => { await verifyStandby(dir, { report }) },
    current: async () => {
      const s = await standbyStatus(dir)
      return s.batch !== null && s.takenAt ? { batch: s.batch, takenAt: s.takenAt } : null
    },
  }
}

function remoteSite(home: string, host: string, dir: string, walnut: string[] | undefined, connect: (host: string) => Promise<DaemonLink>, linkWaitMs?: number): StandbySite {
  const target = new RemoteStandbyTarget({ connect: () => connect(host), dir, walnut, ...(linkWaitMs ? { linkWaitMs } : {}) })
  return {
    label: `${host}:${dir}`,
    // The home's own scratch (tmp/ is rebuildable): staging never reaches the copy.
    batch: () => takeBatch({ home, transport: target, stagingDir: path.join(home, 'tmp', 'standby-staging') }),
    verify: async (out, report) => {
      // A batch that applied ran its verify pass there already.
      const pending = out?.ok && target.lastApply?.pending ? target.lastApply.pending : (await target.verify()).pending
      for (const r of pending) if (await report(r).catch(() => false)) await target.markReported(r.at)
    },
    current: async () => (await target.state()).current,
    unreachable: () => target.unreachable,
  }
}

const defaultConnect = async (host: string): Promise<DaemonLink> => (await import('../hosts/link.js')).link(host)

export async function defaultStandbyDeps(): Promise<StandbyRunnerDeps> {
  return {
    async settings() {
      const [{ getConfig }, { experimentalEnabled }, { isFollower }, { WALNUT_HOME }] = await Promise.all([
        import('../config-manager.js'), import('../experimental.js'), import('../server-role.js'), import('../../constants.js'),
      ])
      const config = await getConfig()
      const raw = Number(config.standby?.interval_seconds)
      const walnut = config.standby?.walnut
      return {
        on: !isFollower() && experimentalEnabled(config.experimental, 'switchable_leader'),
        home: WALNUT_HOME,
        dir: config.standby?.dir,
        ...(config.standby?.host ? { host: config.standby.host } : {}),
        ...(walnut ? { walnut: typeof walnut === 'string' ? [walnut] : walnut } : {}),
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
    const site = s.host ? remoteSite(s.home, s.host, s.dir, s.walnut, d.connect ?? defaultConnect, d.linkWaitMs) : localSite(s.home, s.dir)
    /** The last batch the site was known to hold (a host out of reach cannot say). */
    let known: { batch: number; takenAt: string } | null = null
    const report = (r: DriftReport & { total?: number }) => d.notify({
      title: 'Standby copy: files changed there directly',
      body: `The standby copy at ${site.label} had ${r.total ?? r.items.length} path(s) changed in it directly; each was saved under drift/ and the copy put back to batch ${r.batch}: ${r.items.slice(0, 5).map((i) => `${i.p} (${i.kind})`).join(', ')}`,
      dedupScope: `standby-drift:${r.at}`,
    })
    const once = async (): Promise<BatchOutcome | null> => {
      let out: BatchOutcome | null = null
      for (let attempt = 0; attempt <= RETRIES && !ended; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, RETRY_MS))
        out = await site.batch().catch((err) => ({ ok: false as const, reason: String(err), stats: {} as never }))
        if (out.ok) break
        log.session.info('standby: batch void', { reason: out.reason, attempt })
        // A void batch is tried again soon; a host out of reach is not (the next tick tries).
        if (site.unreachable?.()) break
      }
      const away = site.unreachable?.() === true
      let readErr: string | null = null
      if (!away) {
        await site.verify(out, report).catch((err) => log.session.warn('standby: verify failed', { error: String(err) }))
        const now = await site.current().catch((err) => { readErr = String(err); return undefined })
        if (now !== undefined) known = now
      }
      const status = known
      const behind = !status?.takenAt || Date.now() - Date.parse(status.takenAt) > BEHIND_MS
      if (behind && !behindTold) {
        const holds = away || readErr
          ? `could not be read (${away ? 'its host is out of reach' : readErr}); the last batch known there is ${status ? `batch ${status.batch}, taken at ${status.takenAt}` : 'none'}`
          : `holds ${status?.takenAt ? `batch ${status.batch}, taken at ${status.takenAt}` : 'no complete batch yet'}`
        behindTold = await d.notify({
          title: 'Standby copy is behind',
          body: `The standby copy at ${site.label} ${holds}. Last attempt: ${out && !out.ok ? out.reason : 'ok'}`,
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
      const want = s?.on && s.dir ? `${s.host ?? ''}|${path.resolve(s.dir)}|${JSON.stringify(s.walnut ?? null)}|${s.home}|${s.intervalSeconds}` : ''
      if (want === liveKey) return
      live?.stop()
      live = null
      liveKey = ''
      if (want && s?.dir) {
        live = start(d, { ...s, dir: path.resolve(s.dir) })
        liveKey = want
        log.session.info('standby: batches started (experiment on)', { dir: s.dir, host: s.host ?? null, intervalSeconds: s.intervalSeconds })
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
