/**
 * ONE inbox letter when SSH refuses this machine's sign-in to remote hosts,
 * archived by itself once they connect again. 2026-10-27: the Mac's SSH login
 * expired, every dial to a dev box was refused for hours, and the work and
 * tests there sat stuck with nobody told: the banner only shows while someone
 * has Walnut open.
 *
 * A sign-in failure is something only the user can fix, which is what the
 * inbox is for. Network trouble or a host that is down is not: Walnut retries
 * those on its own, so they never open a letter.
 *
 * Input: every `host:status` frame (the frames every banner reads), so every
 * detection point (the warmup, the reconnect loop, a session start, the folder
 * picker) is already folded into one per-host verdict by the real classifier,
 * credential evidence included.
 *
 * Episodes, each with at most one letter:
 *   - `login`: an expired certificate, a missing agent, an SSH proxy whose own
 *     login expired. That credential is this machine's, so ONE episode holds
 *     every host it fails, each at its own next dial. It closes once no host
 *     fails that way any more and a host of the episode connected again (that
 *     dial proves the login works; a host that only went unreachable proves
 *     nothing), or every host of it left Settings.
 *   - `host:<alias>`: a plain key refusal ("Permission denied (publickey)"
 *     with no expired credential behind it) is that host's own problem, so it
 *     has its own episode, closed when that host connects or leaves Settings.
 *     A host found only in ~/.ssh/config never opens one.
 * A failure stands for GRACE_MS before its letter goes out, so one fixed at
 * once sends nothing. The episodes live in WALNUT_HOME/local (never synced),
 * written BEFORE the letter is sent with the op key the store dedupes on, so a
 * restart at any point neither sends a letter twice nor forgets to close one.
 *
 * The wording is generic; the user's own next step (their login command) comes
 * from config `ssh_login_hint`.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { readJsonFile, writeJsonFile } from '../../utils/fs.js'
import { CLOUD_BOX_HOST_ALIAS } from './cloud-box-host.js'

/** Failure kinds (host-connect-hint.ts) that mean this machine's own login is not usable. */
export const LOGIN_FAILURE_KINDS: ReadonlySet<string> = new Set(['cert_expired', 'agent_missing', 'proxy_login'])

/** How long a sign-in failure stands before the letter goes out. */
export const DEFAULT_GRACE_MS = 60_000

/** The next step when config names none. */
export const GENERIC_LOGIN_HINT = 'refresh your login credentials'

/** The fields of a host:status frame this module reads (removed = the host left Settings). */
export interface AlertFrame {
  host: string
  label?: string
  connected?: boolean
  phase?: string
  kind?: string
  error?: string
  lastKind?: string
  lastError?: string
  discovered?: boolean
  removed?: true
}

export type FrameVerdict = 'login' | 'key' | 'other-failure' | 'ok' | 'gone' | 'neutral'

/** What one frame says about the host's sign-in. In-flight phases and a cleared failure say nothing. */
export function frameVerdict(frame: AlertFrame): FrameVerdict {
  if (frame.removed) return 'gone'
  if (frame.connected) return 'ok'
  const kind = frame.phase === 'failed' ? frame.kind : frame.phase === 'reconnecting' ? frame.lastKind : undefined
  if (!kind) return 'neutral'
  if (LOGIN_FAILURE_KINDS.has(kind)) return 'login'
  if (kind === 'auth') return frame.discovered ? 'neutral' : 'key'
  return 'other-failure'
}

interface FailingHost { cls: 'login' | 'key'; label: string; since: number; error?: string }

interface Episode {
  /** `login`, or `host:<alias>` for one host's key refusal. */
  key: string
  opKey: string
  /** Absent while the send is pending (written before it, so a crash re-sends under the same op key). */
  letterId?: string
  openedAt: number
  hosts: string[]
  /** A host of the episode connected again since it opened. */
  recovered?: boolean
}

interface EpisodeFile { version: 1; episodes: Episode[] }

function namesOf(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? 'a remote host'
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`
  return `${labels[0]} and ${labels.length - 1} more hosts`
}

/** The hint as a clause: trimmed, no trailing period. */
function hintClause(hint: string | undefined): string {
  const h = (hint ?? '').trim().replace(/[.\s]+$/, '')
  return h || GENERIC_LOGIN_HINT
}

/**
 * The letter for the hosts failing now. `retries`: Walnut re-dials these on its
 * own (a login failure); a key refusal waits for the next use or a Retry. Pure.
 */
export function signInLetter(
  hosts: Array<{ label: string; error?: string }>,
  hint?: string,
  opts: { retries?: boolean } = {},
): { subject: string; markdown: string } {
  const labels = hosts.map((h) => h.label)
  const step = hintClause(hint)
  const subject = `SSH sign-in to ${namesOf(labels)} failed: ${step}`
  const bold = labels.map((l) => `**${l}**`)
  const named = bold.length > 1 ? `${bold.slice(0, -1).join(', ')} and ${bold[bold.length - 1]}` : bold[0]
  const lines = [
    `Walnut cannot sign in to ${named} over SSH, so sessions and tests there are stuck. To fix it, ${step}.`,
    opts.retries
      ? 'Walnut keeps retrying and archives this letter by itself once the host connects again.'
      : 'Then use Retry on the host (or start work there); this letter archives itself once the host connects.',
  ]
  const said = hosts.filter((h) => h.error).map((h) => `${h.label}: ${h.error!.replace(/\s+/g, ' ').slice(0, 300)}`)
  if (said.length) lines.push(`What SSH said:\n\n~~~\n${said.join('\n').replace(/~~~/g, '~ ~ ~')}\n~~~`)
  return { subject: subject.length > 200 ? `${subject.slice(0, 199)}…` : subject, markdown: lines.join('\n\n') }
}

export interface HostAuthAlertDeps {
  /** Send the letter, idempotent by `opKey`; resolves with its id. */
  send: (letter: { subject: string; markdown: string; opKey: string }) => Promise<string>
  /** Archive the episode's letter: by id, or (a send cut short by a crash) by its op key. */
  archive: (ref: { letterId?: string; opKey: string }) => Promise<void>
  /** The user's own next step (config ssh_login_hint). */
  loginHint: () => Promise<string | undefined>
  /** Enabled hosts in Settings right now (a host gone from it cannot keep an episode open). */
  knownHosts: () => Set<string>
  /** Connected right now (read once at start, for a login fixed while the server was down). */
  isConnected?: (host: string) => boolean
  statePath?: string
  graceMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void }
  clearTimer?: (t: unknown) => void
}

export interface HostAuthAlert {
  /** Feed one host:status frame. */
  observe: (frame: AlertFrame) => Promise<void>
  /** Run the grace check now (tests; the timer calls it too). */
  check: () => Promise<void>
  /** The open episodes' letter ids (sent ones only). */
  openLetterIds: () => Promise<string[]>
  /** Off: no new letter; a host connecting still archives one already sent. Test seam for the grace too. */
  configure: (opts: { enabled?: boolean; graceMs?: number }) => void
  stop: () => void
}

const episodeKeyOf = (cls: 'login' | 'key', host: string): string => (cls === 'login' ? 'login' : `host:${host}`)

export function createHostAuthAlert(deps: HostAuthAlertDeps): HostAuthAlert {
  const statePath = deps.statePath ?? path.join(WALNUT_HOME, 'local', 'host-auth-alert.json')
  let graceMs = deps.graceMs ?? DEFAULT_GRACE_MS
  let enabled = true
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  const failing = new Map<string, FailingHost>()
  const episodes = new Map<string, Episode>()
  let timer: unknown = null
  let timerAt = 0
  let stopped = false
  // Frames come in bursts (several per connect); one at a time keeps the episode file consistent.
  let chain: Promise<void> = Promise.resolve()
  const serial = (fn: () => Promise<void>): Promise<void> => {
    const next = chain.then(fn).catch((err) => {
      log.session.warn('host sign-in alert step failed', { error: err instanceof Error ? err.message : String(err) })
    })
    chain = next
    return next
  }

  async function save(): Promise<void> {
    if (episodes.size > 0) await writeJsonFile(statePath, { version: 1, episodes: [...episodes.values()] } satisfies EpisodeFile)
    else await fs.rm(statePath, { force: true })
  }

  async function close(ep: Episode, why: string): Promise<void> {
    episodes.delete(ep.key)
    await save()
    try { await deps.archive({ ...(ep.letterId ? { letterId: ep.letterId } : {}), opKey: ep.opKey }) } catch (err) {
      log.session.warn('host sign-in letter could not be archived', { letterId: ep.letterId, opKey: ep.opKey, error: err instanceof Error ? err.message : String(err) })
    }
    log.session.info('host sign-in letter archived', { episode: ep.key, letterId: ep.letterId, why })
  }

  /** Close what is over: a login episode with no login failure left and a recovered host, or no host left. */
  async function settle(): Promise<void> {
    const known = deps.knownHosts()
    for (const ep of [...episodes.values()]) {
      if (known.size > 0) ep.hosts = ep.hosts.filter((h) => known.has(h))
      if (ep.hosts.length === 0) { await close(ep, 'hosts left Settings'); continue }
      if (ep.key !== 'login') continue
      const stillFailing = [...failing.values()].some((f) => f.cls === 'login')
      if (ep.recovered && !stillFailing) await close(ep, 'a host connected and none fails to sign in')
    }
  }

  const loaded = (async () => {
    const raw = await readJsonFile<Partial<EpisodeFile> | null>(statePath, null).catch(() => null)
    for (const ep of Array.isArray(raw?.episodes) ? raw.episodes : []) {
      if (!ep || typeof ep.key !== 'string' || typeof ep.opKey !== 'string' || !Array.isArray(ep.hosts)) continue
      episodes.set(ep.key, {
        key: ep.key, opKey: ep.opKey, openedAt: Number(ep.openedAt) || now(),
        hosts: ep.hosts.filter((h): h is string => typeof h === 'string'),
        ...(typeof ep.letterId === 'string' && ep.letterId ? { letterId: ep.letterId } : {}),
        ...(ep.recovered ? { recovered: true } : {}),
      })
    }
  })()

  function schedule(at: number): void {
    if (stopped) return
    if (timer && timerAt <= at) return
    if (timer) clearTimer(timer)
    timerAt = at
    const t = setTimer(() => { timer = null; void check() }, Math.max(0, at - now()))
    t.unref?.()
    timer = t
  }

  async function sendFor(key: string, hosts: Array<[string, FailingHost]>): Promise<void> {
    const pending = episodes.get(key)
    const ep: Episode = pending ?? { key, opKey: `host-sign-in:${key}:${now().toString(36)}`, openedAt: now(), hosts: [] }
    for (const [h] of hosts) if (!ep.hosts.includes(h)) ep.hosts.push(h)
    episodes.set(key, ep)
    await save()
    const letter = signInLetter(
      hosts.map(([, f]) => ({ label: f.label, ...(f.error ? { error: f.error } : {}) })),
      await deps.loginHint().catch(() => undefined),
      { retries: key === 'login' },
    )
    try {
      ep.letterId = await deps.send({ ...letter, opKey: ep.opKey })
    } catch (err) {
      log.session.warn('host sign-in letter could not be sent; trying again', { episode: key, error: err instanceof Error ? err.message : String(err) })
      schedule(now() + Math.max(graceMs, 5_000))
      return
    }
    await save()
    log.session.warn('host sign-in failed: letter sent', { episode: key, letterId: ep.letterId, hosts: ep.hosts })
  }

  function check(): Promise<void> {
    return serial(async () => {
      await loaded
      if (!enabled || failing.size === 0) return
      const groups = new Map<string, Array<[string, FailingHost]>>()
      for (const entry of failing) {
        const key = episodeKeyOf(entry[1].cls, entry[0])
        if (episodes.get(key)?.letterId) continue
        groups.set(key, [...(groups.get(key) ?? []), entry])
      }
      let next = Infinity
      for (const [key, hosts] of groups) {
        const due = hosts.some(([, f]) => now() - f.since >= graceMs)
        if (due) await sendFor(key, hosts)
        else next = Math.min(next, ...hosts.map(([, f]) => f.since + graceMs))
      }
      if (next < Infinity) schedule(next)
    })
  }

  function observe(frame: AlertFrame): Promise<void> {
    if (stopped || !frame?.host || frame.host === '__local__' || frame.host === CLOUD_BOX_HOST_ALIAS) return Promise.resolve()
    const verdict = frameVerdict(frame)
    if (verdict === 'neutral') return Promise.resolve()
    return serial(async () => {
      await loaded
      const { host } = frame
      if (verdict === 'login' || verdict === 'key') {
        if (!enabled) return
        const prev = failing.get(host)
        const same = prev?.cls === verdict
        const error = (frame.phase === 'failed' ? frame.error : frame.lastError) || (same ? prev?.error : undefined)
        const since = same ? prev!.since : now()
        failing.set(host, { cls: verdict, label: frame.label || prev?.label || host, since, ...(error ? { error } : {}) })
        const ep = episodes.get(episodeKeyOf(verdict, host))
        if (ep?.letterId) {
          if (!ep.hosts.includes(host)) { ep.hosts.push(host); await save() }
          return
        }
        schedule(since + graceMs)
        return
      }
      const wasFailing = failing.delete(host)
      const touched = [...episodes.values()].filter((ep) => ep.hosts.includes(host))
      if (!wasFailing && touched.length === 0) return
      // A network failure says nothing about the sign-in: no episode counts it as
      // recovered, but it may have been the last host still failing to sign in.
      if (verdict !== 'other-failure') {
        for (const ep of touched) {
          if (verdict === 'gone') ep.hosts = ep.hosts.filter((h) => h !== host)
          else if (ep.key === 'login') ep.recovered = true
          else await close(ep, 'the host connected')
        }
      }
      await settle()
      if (episodes.size > 0) await save()
    })
  }

  // A login fixed or a host removed while the server was down: no frame may ever say so.
  void serial(async () => {
    await loaded
    if (episodes.size === 0) return
    for (const ep of [...episodes.values()]) {
      if (!ep.hosts.some((h) => deps.isConnected?.(h))) continue
      if (ep.key === 'login') ep.recovered = true
      else await close(ep, 'the host is connected')
    }
    // An empty list is a config not read yet, never "every host is gone".
    if (deps.knownHosts().size > 0) await settle()
    if (episodes.size > 0) await save()
  })

  return {
    observe,
    check,
    openLetterIds: async () => { await chain; return [...episodes.values()].flatMap((e) => (e.letterId ? [e.letterId] : [])) },
    configure: (opts) => {
      if (opts.enabled !== undefined) enabled = opts.enabled
      if (opts.graceMs !== undefined) graceMs = Math.max(0, opts.graceMs)
      if (!enabled) failing.clear()
    },
    stop: () => { stopped = true; if (timer) clearTimer(timer); timer = null },
  }
}

// ── Server wiring ──

let running: HostAuthAlert | null = null

/**
 * Listen to every host:status frame (primary only; server.ts host wiring).
 * `WALNUT_HOST_SIGN_IN_LETTER=0` sends no new letter; the Playwright host
 * fixture starts it that way too (its hosts fail on purpose) and turns it on
 * per spec.
 */
export async function startHostAuthAlert(opts: { knownHosts: () => Set<string>; enabled?: boolean }): Promise<() => void> {
  const { bus, EventNames } = await import('../event-bus.js')
  const { findLetterByOp, sendLetterOnce, setArchived } = await import('../human-inbox/store.js')
  const { getConfig } = await import('../config-manager.js')
  const { isDaemonConnected } = await import('../../providers/daemon-connection.js')
  const graceEnv = Number(process.env.WALNUT_HOST_SIGN_IN_LETTER_GRACE_MS)
  const alert = createHostAuthAlert({
    send: async ({ subject, markdown, opKey }) => (await sendLetterOnce({
      subject, type: 'review', markdown, sender: { sessionId: 'external', host: 'local' },
    }, { opKey })).letter.id,
    archive: async ({ letterId, opKey }) => {
      const id = letterId ?? (await findLetterByOp(opKey))?.id
      if (id) await setArchived(id, true)
    },
    loginHint: async () => {
      const hint = (await getConfig()).ssh_login_hint
      return typeof hint === 'string' ? hint : undefined
    },
    knownHosts: opts.knownHosts,
    isConnected: (host) => isDaemonConnected(host),
    ...(process.env.WALNUT_HOST_SIGN_IN_LETTER_GRACE_MS && Number.isFinite(graceEnv) && graceEnv >= 0 ? { graceMs: graceEnv } : {}),
  })
  alert.configure({ enabled: opts.enabled !== false && process.env.WALNUT_HOST_SIGN_IN_LETTER !== '0' })
  running = alert
  bus.subscribe('host-auth-alert', (event) => alert.observe(event.data as AlertFrame), { global: true, interest: [EventNames.HOST_STATUS] })
  return () => {
    bus.unsubscribe('host-auth-alert')
    alert.stop()
    if (running === alert) running = null
  }
}

/** The running alert (the host fixture route drives it), or null. */
export function runningHostAuthAlert(): HostAuthAlert | null {
  return running
}
