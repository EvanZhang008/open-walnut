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
 * fell more than five minutes behind, once per episode. Behind is told while a batch still runs
 * (a first batch over a slow link sends for hours), with how far it got; a batch that lands late
 * is progress, never a new "behind", and only a batch that lands fresh ends the episode.
 */
import fs from 'node:fs'
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
  /** How old the standby's batch may get before it is told behind (default 5 min; tests shorten it). */
  behindMs?: number
  /** After each complete batch (`takenAt`: its moment): the leader switch's cleanup (default: afterSwitchCleanup). */
  afterBatch?(home: string, takenAt: string): Promise<void>
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
  /** Stop sending there (a remote site's queue of chunks): the runner stopped or its settings changed. */
  close?(): void
  /** What the site was last seen to hold, without asking it (undefined: not seen yet). A site without it is read. */
  seen?(): { batch: number; takenAt: string } | null | undefined
  /** How far the batch under way got (its chunks sent, its apply), or null. */
  progress?(): string | null
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
  // Chunks wait to go in the home's rebuildable scratch (remote-spool.ts), never in memory.
  const target = new RemoteStandbyTarget({ connect: () => connect(host), dir, walnut, spoolDir: path.join(home, 'tmp', 'standby-spool'), ...(linkWaitMs ? { linkWaitMs } : {}) })
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
    close: () => target.close(),
    seen: () => target.seen,
    progress: () => target.progress(),
  }
}

const defaultConnect = async (host: string): Promise<DaemonLink> => (await import('../hosts/link.js')).link(host)

export async function defaultStandbyDeps(): Promise<StandbyRunnerDeps> {
  return {
    async settings() {
      const [{ getConfig }, { experimentalEnabled }, { bootPolicy }, { WALNUT_HOME }] = await Promise.all([
        import('../config-manager.js'), import('../experimental.js'), import('../boot-policy.js'), import('../../constants.js'),
      ])
      const config = await getConfig()
      const raw = Number(config.standby?.interval_seconds)
      const walnut = config.standby?.walnut
      return {
        // The leader only, and never a leader switch's trial start: that home has not led yet (its trial column).
        on: bootPolicy('standby-copy') && experimentalEnabled(config.experimental, 'switchable_leader'),
        home: WALNUT_HOME,
        dir: config.standby?.dir,
        ...(config.standby?.host ? { host: config.standby.host } : {}),
        ...(walnut ? { walnut: typeof walnut === 'string' ? [walnut] : walnut } : {}),
        intervalSeconds: Number.isFinite(raw) && raw >= 5 ? raw : 30,
      }
    },
    notify: async () => false,
    afterBatch: afterSwitchCleanup(),
  }
}

/**
 * A home a leader switch made the leader keeps the old leader's final batch in this machine's
 * standby folder until the switch-back window passed (core/leader/switch/standby-cleanup.ts):
 * looked at after a complete batch of this home, which is one of its conditions. A home no
 * switch made the leader has no history.json, and nothing of the switch is loaded.
 */
export type AfterSwitchCleanup = ((home: string, takenAt: string) => Promise<void>) & {
  /** Resolves once no removal runs (tests). */
  whenIdle(): Promise<void>
}

export function afterSwitchCleanup(): AfterSwitchCleanup {
  let nextLook = 0
  /** One look (and removal) at a time; started detached, so the batch loop never waits on it. */
  let inFlight: Promise<void> | null = null
  const look = async (home: string, takenAt: string): Promise<void> => {
    const { cleanSwitchedStandby } = await import('../leader/switch/standby-cleanup.js')
    const r = await cleanSwitchedStandby({ home, ownBatchTakenAt: takenAt })
    if (r.removed) {
      log.session.info('standby: the old leader\'s final batch removed from this machine\'s standby folder (switch-back window passed)', { dir: r.dir, switchId: r.switchId, bytes: r.bytes, refused: r.refused })
      nextLook = Infinity
    } else if (r.notBefore) {
      nextLook = r.notBefore
    } else if (r.dir && r.why === 'the folder holds no standby copy') {
      nextLook = Infinity
    } else if (r.dir) {
      log.session.debug('standby: switch folder kept', { dir: r.dir, why: r.why })
    }
  }
  const fn = async (home: string, takenAt: string): Promise<void> => {
    if (inFlight || Date.now() < nextLook || !fs.existsSync(path.join(home, 'local', 'leader-switch', 'history.json'))) return
    inFlight = look(home, takenAt)
      .catch((err) => log.session.warn('standby: switch folder cleanup failed', { error: String(err) }))
      .finally(() => { inFlight = null })
  }
  return Object.assign(fn, { whenIdle: async () => { await inFlight } })
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
    const behindMs = d.behindMs ?? BEHIND_MS
    const old = (held: { takenAt: string } | null | undefined) => !held?.takenAt || Date.now() - Date.parse(held.takenAt) > behindMs
    const holding = (held: { batch: number; takenAt: string } | null | undefined) => held ? `batch ${held.batch}, taken at ${held.takenAt}` : 'no complete batch yet'
    const site = s.host ? remoteSite(s.home, s.host, s.dir, s.walnut, d.connect ?? defaultConnect, d.linkWaitMs) : localSite(s.home, s.dir)
    /** The last batch the site was known to hold (a host out of reach cannot say). */
    let known: { batch: number; takenAt: string } | null = null
    const report = (r: DriftReport & { total?: number }) => d.notify({
      title: 'Standby copy: files changed there directly',
      body: `The standby copy at ${site.label} had ${r.total ?? r.items.length} path(s) changed in it directly; each was saved under drift/ and the copy put back to batch ${r.batch}: ${r.items.slice(0, 5).map((i) => `${i.p} (${i.kind})`).join(', ')}`,
      dedupScope: `standby-drift:${r.at}`,
    })
    /** A batch that runs past `behindMs` while the standby holds nothing newer: told now, with how far it got. */
    const tellWhileRunning = async (since: number) => {
      if (ended || behindTold) return
      // A remote site says what it last saw (asking it would queue behind the batch); a folder here is read.
      const held = site.seen ? site.seen() : known ?? await site.current().catch(() => undefined)
      if (ended || behindTold || held === undefined || !old(held)) return
      const far = site.progress?.()
      const secs = Math.round((Date.now() - since) / 1000)
      behindTold = true
      behindTold = await d.notify({
        title: 'Standby copy is behind',
        body: `The standby copy at ${site.label} holds ${holding(held)}. A batch has been running for ${secs < 120 ? `${secs} s` : `${Math.round(secs / 60)} min`}${far ? `: ${far}` : ''}`,
        dedupScope: 'standby-behind',
        recoveryKey: 'standby',
      })
    }
    const once = async (): Promise<BatchOutcome | null> => {
      const since = Date.now()
      const tick = setInterval(() => { void tellWhileRunning(since).catch(() => {}) }, behindMs)
      tick.unref?.()
      try {
        return await batchOnce()
      } finally {
        clearInterval(tick)
      }
    }
    const batchOnce = async (): Promise<BatchOutcome | null> => {
      let out: BatchOutcome | null = null
      for (let attempt = 0; attempt <= RETRIES && !ended; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, RETRY_MS))
        out = await site.batch().catch((err) => ({ ok: false as const, reason: String(err), stats: {} as never }))
        if (out.ok) break
        log.session.info('standby: batch void', { reason: out.reason, attempt })
        // A void batch is tried again soon; a host out of reach is not (the next tick tries).
        if (site.unreachable?.()) break
      }
      // Stopped meanwhile: no verify, no read, no notice.
      if (ended) return out
      const away = site.unreachable?.() === true
      let readErr: string | null = null
      if (!away) {
        await site.verify(out, report).catch((err) => log.session.warn('standby: verify failed', { error: String(err) }))
        const now = await site.current().catch((err) => { readErr = String(err); return undefined })
        if (now !== undefined) known = now
      }
      if (out?.ok && !ended) await d.afterBatch?.(s.home, out.manifest.takenAt).catch((err) => log.session.warn('standby: after-batch cleanup failed', { error: String(err) }))
      const status = known
      const stale = old(status)
      // A batch that just landed is progress, even one that took long to send: never a new "behind".
      const behind = stale && !out?.ok
      if (behind && !behindTold) {
        const holds = away || readErr
          ? `could not be read (${away ? 'its host is out of reach' : readErr}); the last batch known there is ${status ? `batch ${status.batch}, taken at ${status.takenAt}` : 'none'}`
          : `holds ${holding(status)}`
        behindTold = await d.notify({
          title: 'Standby copy is behind',
          body: `The standby copy at ${site.label} ${holds}. Last attempt: ${out && !out.ok ? out.reason : 'ok'}`,
          dedupScope: 'standby-behind',
          recoveryKey: 'standby',
        })
      } else if (!stale && behindTold) {
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
        site.close?.()
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
