/**
 * ONE inbox letter when macOS blocks Walnut from the local network, archived by itself once
 * Walnut reaches it again. 2026-11-03: a copy of Walnut.app re-bundled under another bundle id
 * (the same program) had its "Local Network" prompt answered Don't Allow, and macOS then judged
 * Walnut's whole process tree as that copy: every connection to a local address failed at once
 * with "No route to host" for about 30 minutes, SSH to machines on the LAN failed and joined
 * machines fell back to the relay, and nobody was told. Only the user can lift that (System
 * Settings > Privacy & Security > Local Network), which is what the inbox is for.
 *
 * The check (local-network-probe.ts) knocks on the default gateway: 2 minutes after start, then
 * every 10 minutes, every 2 while an episode is open. An episode opens at the first 'blocked'
 * verdict; its letter goes out at a second one at least CONFIRM_MS later (an 'unknown' between
 * them changes nothing, but a lone sighting older than STALE_SIGHTING_MS starts over), so a block
 * lifted at once sends nothing. One episode = at most one letter.
 *
 * The episode closes, archiving its letter (an archive that failed keeps it open for the next
 * check), when the network is 'reachable': through the gateway, or, while an episode is open,
 * through the probe's second proof (`deep`). A gateway that drops every port, or a full-tunnel
 * VPN, may never show either, so it also closes after QUIET_CLOSE_MS with no 'blocked' verdict
 * (a lone unconfirmed sighting after STALE_SIGHTING_MS): a fixed setting never leaves the letter up.
 *
 * The episode lives in WALNUT_HOME/local (never synced), written BEFORE the letter is sent with
 * the op key the store dedupes on, so a restart at any point neither sends a letter twice nor
 * forgets to archive one.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { readJsonFile, writeJsonFile } from '../../utils/fs.js'
import { LOCAL_NETWORK_BLOCKED } from '../human-inbox/walnut-letters/local-network-blocked.js'
import { letterOpKey } from '../human-inbox/walnut-letters/kind.js'
import type { LetterLang } from '../human-inbox/walnut-letters/languages.js'
import type { LocalNetworkProbeResult, LocalNetworkVerdict } from './local-network-probe.js'

/** The first check after start. */
export const FIRST_CHECK_MS = 2 * 60_000
/** Between checks while nothing is wrong. */
export const IDLE_EVERY_MS = 10 * 60_000
/** Between checks while an episode is open. */
export const EPISODE_EVERY_MS = 2 * 60_000
/** A second 'blocked' verdict at least this long after the first sends the letter. */
export const CONFIRM_MS = 60_000
/** An unconfirmed first sighting older than this is replaced by the next 'blocked' one. */
export const STALE_SIGHTING_MS = 10 * 60_000
/** A confirmed episode with no 'blocked' verdict for this long is over. */
export const QUIET_CLOSE_MS = 24 * 60 * 60_000
/** How far `lastBlockedAt` may lag before a 'blocked' verdict writes it (saves a write per check). */
export const BLOCKED_MARK_STEP_MS = 10 * 60_000

export interface LocalNetworkEpisode {
  opKey: string
  /** The first 'blocked' verdict of the episode. */
  openedAt: number
  /** The confirming verdict: the letter is due (written before the send, so a crash re-sends under the same op key). */
  confirmedAt?: number
  letterId?: string
  gateway?: string
  /** The latest 'blocked' verdict, at most BLOCKED_MARK_STEP_MS behind. */
  lastBlockedAt?: number
}

interface StateFile { version: 1; episode: LocalNetworkEpisode }

/** The letter for an episode first seen at `firstSeenAt`. Pure; the words live in the letter registry. */
export function localNetworkLetter(firstSeenAt: number, lang: LetterLang = 'en', program?: string): { subject: string; markdown: string } {
  const { subject, markdown } = LOCAL_NETWORK_BLOCKED.render(lang, { firstSeenAt, ...(program ? { program } : {}) })
  return { subject, markdown }
}

export interface LocalNetworkAlertDeps {
  /** One check of the local network (probeLocalNetwork with the real io); `deep` while an episode is open. */
  probe: (opts: { deep: boolean }) => Promise<LocalNetworkProbeResult>
  /** Send the letter, idempotent by `opKey`; resolves with its id. */
  send: (letter: { subject: string; markdown: string; opKey: string }) => Promise<string>
  /** Archive the episode's letter: by id, or (a send cut short by a crash) by its op key. */
  archive: (ref: { letterId?: string; opKey: string }) => Promise<void>
  /** The user's letter language; English when absent. */
  language?: () => Promise<LetterLang>
  /** The entry macOS lists for this server in Local Network (serverLocalNetworkName); "Walnut" when absent. */
  program?: () => Promise<string>
  statePath?: string
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void }
  clearTimer?: (t: unknown) => void
}

export interface LocalNetworkAlert {
  /** Arm the first check, FIRST_CHECK_MS out. */
  start: () => void
  /** Run one check now and re-arm the clock from its result (the timer calls it too). */
  check: () => Promise<LocalNetworkVerdict | null>
  /** The open episode, or null. */
  episode: () => Promise<LocalNetworkEpisode | null>
  stop: () => void
}

const UNKNOWN: LocalNetworkProbeResult = { verdict: 'unknown', gateway: null, attempts: [], linkKnown: null }

export function createLocalNetworkAlert(deps: LocalNetworkAlertDeps): LocalNetworkAlert {
  const statePath = deps.statePath ?? path.join(WALNUT_HOME, 'local', 'local-network-alert.json')
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  let episode: LocalNetworkEpisode | null = null
  let lastVerdict: LocalNetworkVerdict | null = null
  let timer: unknown = null
  let stopped = false
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    const next = chain.then(fn).catch((err) => {
      log.session.warn('local network check step failed', { error: err instanceof Error ? err.message : String(err) })
      return fallback
    })
    chain = next
    return next
  }

  const loaded = (async () => {
    const raw = await readJsonFile<Partial<StateFile> | null>(statePath, null).catch(() => null)
    const ep = raw?.episode
    if (!ep || typeof ep.opKey !== 'string' || !ep.opKey) return
    episode = {
      opKey: ep.opKey,
      openedAt: Number(ep.openedAt) || now(),
      ...(Number(ep.confirmedAt) ? { confirmedAt: Number(ep.confirmedAt) } : {}),
      ...(typeof ep.letterId === 'string' && ep.letterId ? { letterId: ep.letterId } : {}),
      ...(typeof ep.gateway === 'string' && ep.gateway ? { gateway: ep.gateway } : {}),
      ...(Number(ep.lastBlockedAt) ? { lastBlockedAt: Number(ep.lastBlockedAt) } : {}),
    }
  })()

  async function save(): Promise<void> {
    if (episode) await writeJsonFile(statePath, { version: 1, episode } satisfies StateFile)
    else await fs.rm(statePath, { force: true })
  }

  function arm(ms: number): void {
    if (stopped) return
    if (timer) clearTimer(timer)
    const t = setTimer(() => { timer = null; void check() }, ms)
    t.unref?.()
    timer = t
  }

  /** Archive first, then forget: an archive that failed keeps the episode, and the next reachable check tries again. */
  async function close(why: string): Promise<void> {
    const ep = episode!
    // A letter exists only once the episode was confirmed (a send cut short may still have made it).
    if (ep.letterId || ep.confirmedAt) {
      try { await deps.archive({ ...(ep.letterId ? { letterId: ep.letterId } : {}), opKey: ep.opKey }) } catch (err) {
        log.session.warn('local network letter could not be archived; trying at the next check', { letterId: ep.letterId, opKey: ep.opKey, error: err instanceof Error ? err.message : String(err) })
        return
      }
    }
    episode = null
    await save()
    log.session.info('local network episode closed', { letterId: ep.letterId, opKey: ep.opKey, why })
  }

  async function deliver(ep: LocalNetworkEpisode): Promise<void> {
    const lang = (await deps.language?.().catch(() => 'en' as const)) ?? 'en'
    const program = await deps.program?.().catch(() => undefined)
    try {
      ep.letterId = await deps.send({ ...localNetworkLetter(ep.openedAt, lang, program), opKey: ep.opKey })
    } catch (err) {
      // The episode stays confirmed: the next 'blocked' check sends again under the same op key.
      log.session.warn('local network letter could not be sent; trying at the next check', { error: err instanceof Error ? err.message : String(err) })
      return
    }
    await save()
    log.session.warn('macOS blocks Walnut from the local network: letter sent', { letterId: ep.letterId, gateway: ep.gateway, openedAt: ep.openedAt })
  }

  async function onBlocked(at: number, gateway: string | null): Promise<void> {
    if (!episode) {
      episode = { opKey: letterOpKey(LOCAL_NETWORK_BLOCKED.id, at.toString(36)), openedAt: at, lastBlockedAt: at, ...(gateway ? { gateway } : {}) }
      await save()
      return
    }
    if (episode.letterId) {
      if (at - (episode.lastBlockedAt ?? episode.openedAt) >= BLOCKED_MARK_STEP_MS) {
        episode.lastBlockedAt = at
        await save()
      }
      return
    }
    if (!episode.confirmedAt && at - episode.openedAt > STALE_SIGHTING_MS) {
      // A lone sighting long ago (the server was down since) is not "in a row": start over.
      episode.openedAt = at
      episode.lastBlockedAt = at
      if (gateway) episode.gateway = gateway
      await save()
    } else if (!episode.confirmedAt && at - episode.openedAt >= CONFIRM_MS) {
      episode.confirmedAt = at
      episode.lastBlockedAt = at
      await save()
    } else if (episode.confirmedAt) {
      // A send that failed before: deliver() saves this with the letter id.
      episode.lastBlockedAt = at
    }
    if (episode.confirmedAt) await deliver(episode)
  }

  async function step(): Promise<LocalNetworkVerdict | null> {
    await loaded
    if (stopped) return null
    const result = await deps.probe({ deep: episode !== null }).catch(() => UNKNOWN)
    if (stopped) return null
    const { verdict } = result
    if (verdict !== lastVerdict) {
      log.session.info('local network verdict changed', {
        from: lastVerdict, to: verdict, gateway: result.gateway, attempts: result.attempts, linkKnown: result.linkKnown,
        ...(result.proof ? { proof: result.proof } : {}),
      })
      lastVerdict = verdict
    }
    const at = now()
    if (verdict === 'reachable') {
      if (episode) await close(result.proof ? `the local network answered at ${result.proof.host}:${result.proof.port}` : 'Walnut reaches the local network again')
    } else if (verdict === 'blocked') {
      await onBlocked(at, result.gateway)
    } else if (episode) {
      // 'unknown' keeps the state, except for an episode no 'blocked' verdict has backed for long.
      if (!episode.confirmedAt && at - episode.openedAt > STALE_SIGHTING_MS) await close('a lone blocked check went stale')
      else if (episode.confirmedAt && at - (episode.lastBlockedAt ?? episode.confirmedAt) >= QUIET_CLOSE_MS) await close('no blocked check for a day')
    }
    return verdict
  }

  function check(): Promise<LocalNetworkVerdict | null> {
    const run = serial(step, null)
    // Re-armed from the outcome, whoever asked: the cadence always follows the episode.
    void run.then(() => arm(episode ? EPISODE_EVERY_MS : IDLE_EVERY_MS))
    return run
  }

  return {
    start: () => { if (!timer) arm(FIRST_CHECK_MS) },
    check,
    episode: async () => { await loaded; await chain; return episode ? { ...episode } : null },
    stop: () => { stopped = true; if (timer) clearTimer(timer); timer = null },
  }
}

// ── Server wiring ──

/** Why the check does not run in this process, or null when it does. Pure. */
export function localNetworkAlertOff(i: { platform: NodeJS.Platform; enabled: boolean; env: NodeJS.ProcessEnv; isolated: boolean }): string | null {
  if (i.platform !== 'darwin') return 'not macOS'
  if (!i.enabled) return 'host fixture'
  const flag = i.env.WALNUT_LOCAL_NETWORK_LETTER
  if (flag === '0') return 'turned off (WALNUT_LOCAL_NETWORK_LETTER=0)'
  if (flag === '1') return null
  // A test or throwaway server shares the Mac's network but not its user: its letter would land
  // in a copied inbox nobody reads, and its probes would double the real server's.
  return i.isolated ? 'isolated server' : null
}

let running: LocalNetworkAlert | null = null

/**
 * The entry macOS lists for this server in Local Network: "Walnut" when Walnut.app is above it (the
 * app started it, or the deploy ran it through the session host, scripts/dev-prod.sh), else the
 * program itself, which macOS lists under its file name (`walnut-darwin-arm64`).
 */
export async function serverLocalNetworkName(): Promise<string> {
  const { detectLauncher } = await import('../permissions/darwin.js')
  const launcher = await detectLauncher().catch(() => null)
  return launcher?.kind === 'mac-app' ? 'Walnut' : path.basename(process.execPath)
}

/**
 * Check the local network on a clock (primary only; server.ts host wiring, beside the sign-in
 * letter). macOS only; off on the host fixture and on every isolated server (the test runner, an
 * ephemeral child, a data home in a temp or task dir, a fake HOME). `WALNUT_LOCAL_NETWORK_LETTER`
 * =0 turns it off, =1 on for an isolated server. `platform`, `isolated` and `deps` are test seams.
 */
export async function startLocalNetworkAlert(opts: {
  enabled?: boolean
  platform?: NodeJS.Platform
  isolated?: boolean
  deps?: Partial<LocalNetworkAlertDeps>
} = {}): Promise<() => void> {
  const platform = opts.platform ?? process.platform
  if (platform !== 'darwin') return () => {}
  let isolated = opts.isolated
  if (isolated === undefined) {
    const [{ semanticLaneDecision }, { IS_EPHEMERAL }] = await Promise.all([
      import('../search/semantic-default.js'), import('../../constants.js'),
    ])
    // The semantic lane's "is this a real install" test, without its own opt-in flag (net-mac.ts does the same).
    isolated = !semanticLaneDecision({ env: { ...process.env, WALNUT_SEARCH_V2_SEMANTIC: undefined }, isEphemeral: IS_EPHEMERAL, walnutHome: WALNUT_HOME }).on
  }
  const off = localNetworkAlertOff({ platform, enabled: opts.enabled !== false, env: process.env, isolated })
  if (off) {
    log.session.info('local network check off', { reason: off })
    return () => {}
  }
  const { findLetterByOp, sendLetterOnce, setArchived } = await import('../human-inbox/store.js')
  const { walnutLetterLanguage } = await import('../human-inbox/walnut-letters/languages.js')
  const { probeLocalNetwork, defaultLocalNetworkProbeIo } = await import('./local-network-probe.js')
  const alert = createLocalNetworkAlert({
    probe: (o) => probeLocalNetwork(defaultLocalNetworkProbeIo, o),
    send: async ({ subject, markdown, opKey }) => (await sendLetterOnce({
      subject, type: 'review', markdown, sender: { sessionId: 'external', host: 'local' },
    }, { opKey })).letter.id,
    // By op key, which every letter of an episode carries: a letter the user deleted is done, not
    // an error the next check would retry forever, and one already archived is left as it is.
    archive: async ({ opKey }) => {
      const letter = await findLetterByOp(opKey)
      if (letter && !letter.archived) await setArchived(letter.id, true)
    },
    language: walnutLetterLanguage,
    program: serverLocalNetworkName,
    ...opts.deps,
  })
  alert.start()
  running = alert
  return () => {
    alert.stop()
    if (running === alert) running = null
  }
}

/** The running check, or null (tests drive it). */
export function runningLocalNetworkAlert(): LocalNetworkAlert | null {
  return running
}
