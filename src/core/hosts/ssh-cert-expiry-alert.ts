/**
 * ONE inbox letter a few hours before this machine's SSH certificate for remote hosts expires,
 * and one more turn in it when it has run out and a fresh sign-in fails; archived by itself once
 * a renewed certificate is in place. 2026-11-04: the Mac's certificate expired at 15:52 UTC with
 * nobody told before a task hit "Permission denied (publickey)", and the sign-in letter
 * (host-auth-alert.ts) stayed quiet, because Walnut's own long-lived connection to the host still
 * worked: no dial of Walnut's failed, so no frame said so. Renewing needs the user's own hand (a
 * PIN, a key), which is what the inbox is for, and a few hours ahead is when it still helps.
 *
 * The certificate carries its expiry: every CHECK_EVERY_MS this reads it for each enabled remote
 * host (sshCertificateExpiry: `ssh -G`'s certificatefile, else the agent's certificates, read
 * with `ssh-keygen -L`; config and local files only). An episode opens when the soonest expiry is
 * WARN_AHEAD_MS away or less; its letter names the hosts that share that certificate. Past the
 * expiry the check dials one of them with a FRESH ssh (no shared connection, so a long-lived one
 * cannot hide it); a refused sign-in adds the expired turn to the same letter, once. The episode
 * closes (archiving the letter) when the certificate those hosts use is valid past the episode's
 * expiry (renewed), or none of its hosts is left in Settings. host-auth-alert.ts joins a letter
 * open here instead of sending its own (joinLetter), so one expiry is one thread.
 *
 * The episode lives in WALNUT_HOME/local (never synced), written BEFORE the letter is sent with
 * the op key the store dedupes on, so a restart neither sends a letter twice nor forgets one.
 * The wording is generic; the user's own renew step comes from config `ssh_login_hint`.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { readJsonFile, writeJsonFile } from '../../utils/fs.js'
import { SSH_CERT_EXPIRY, sshCertExpiredTurn } from '../human-inbox/walnut-letters/ssh-cert-expiry.js'
import { letterOpKey } from '../human-inbox/walnut-letters/kind.js'
import type { LetterLang } from '../human-inbox/walnut-letters/languages.js'

/** The first check after start. */
export const FIRST_CHECK_MS = 2 * 60_000
/** Between checks. */
export const CHECK_EVERY_MS = 10 * 60_000
/** Between checks from the warning until the expired turn (or renewal). */
export const NEAR_EVERY_MS = 2 * 60_000
/** How long before the expiry the letter goes out. */
export const WARN_AHEAD_MS = 3 * 60 * 60_000
/** Two hosts whose certificates expire this close together share one. */
const SAME_CERT_MS = 60_000

export interface CertHost {
  /** The host's key in Settings. */
  host: string
  /** Its name as the user reads it. */
  label: string
}

export interface CertExpiryEpisode {
  opKey: string
  /** When the certificate expires (epoch ms). */
  expiresAt: number
  hosts: string[]
  labels: string[]
  openedAt: number
  letterId?: string
  /** The expired turn went into the letter. */
  expiredTold?: true
  /** Past the expiry a fresh sign-in still worked: the host needs no certificate, the letter was archived. */
  signInWorks?: true
}

interface StateFile { version: 1; episode: CertExpiryEpisode }

export interface CertExpiryAlertDeps {
  /** The enabled remote hosts reached over SSH. */
  hosts: () => Promise<CertHost[]>
  /** When the certificate this machine uses for `host` expires (sshCertificateExpiry): null when it uses none. */
  certExpiry: (host: string) => Promise<number | null>
  /** One fresh SSH sign-in to `host`, sharing no connection: ok, refused (what ssh said), or unknown (the host did not answer). */
  freshSignIn: (host: string) => Promise<{ ok: boolean; error?: string; unknown?: boolean }>
  /** Send the letter, idempotent by `opKey`; resolves with its id. */
  send: (letter: { subject: string; markdown: string; opKey: string }) => Promise<string>
  /** Add a turn to the letter (flips it unread). */
  addTurn: (letterId: string, text: string) => Promise<void>
  /** Archive the letter: by id, or (a send cut short by a crash) by its op key. */
  archive: (ref: { letterId?: string; opKey: string }) => Promise<void>
  /** The user's own renew step (config ssh_login_hint). */
  loginHint: () => Promise<string | undefined>
  /**
   * Another reminder owns the certificate (config `ssh_cert_letter: false`, set by whatever warns
   * instead, a plugin or the user): no letter here, an open one is archived, and the sign-in
   * alert sends its own. Read at every check, so the switch takes effect without a restart.
   */
  handedOff?: () => Promise<boolean>
  language?: () => Promise<LetterLang>
  statePath?: string
  warnAheadMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void }
  clearTimer?: (t: unknown) => void
}

export interface CertExpiryAlert {
  start: () => void
  /** One check now; re-arms the clock (the timer calls it too). */
  check: () => Promise<void>
  episode: () => Promise<CertExpiryEpisode | null>
  /**
   * A sign-in failure host-auth-alert.ts saw on these hosts: the letter open here for one of them
   * (its id), with the expired turn added once the expiry has passed, or null when none is open.
   */
  joinLetter: (hosts: string[], error?: string) => Promise<string | null>
  stop: () => void
}

export function createCertExpiryAlert(deps: CertExpiryAlertDeps): CertExpiryAlert {
  const statePath = deps.statePath ?? path.join(WALNUT_HOME, 'local', 'ssh-cert-expiry-alert.json')
  const warnAhead = deps.warnAheadMs ?? WARN_AHEAD_MS
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  let episode: CertExpiryEpisode | null = null
  let timer: unknown = null
  let stopped = false
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    const next = chain.then(fn).catch((err) => {
      log.session.warn('ssh certificate check step failed', { error: err instanceof Error ? err.message : String(err) })
      return fallback
    })
    chain = next
    return next
  }

  const loaded = (async () => {
    const raw = await readJsonFile<Partial<StateFile> | null>(statePath, null).catch(() => null)
    const ep = raw?.episode
    if (!ep || typeof ep.opKey !== 'string' || !ep.opKey || !Number(ep.expiresAt) || !Array.isArray(ep.hosts)) return
    episode = {
      opKey: ep.opKey,
      expiresAt: Number(ep.expiresAt),
      hosts: ep.hosts.filter((h): h is string => typeof h === 'string'),
      labels: Array.isArray(ep.labels) ? ep.labels.filter((h): h is string => typeof h === 'string') : [],
      openedAt: Number(ep.openedAt) || now(),
      ...(typeof ep.letterId === 'string' && ep.letterId ? { letterId: ep.letterId } : {}),
      ...(ep.expiredTold ? { expiredTold: true as const } : {}),
      ...(ep.signInWorks ? { signInWorks: true as const } : {}),
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

  const lang = async (): Promise<LetterLang> => (await deps.language?.().catch(() => 'en' as const)) ?? 'en'
  const hint = async (): Promise<string | undefined> => deps.loginHint().catch(() => undefined)
  const handedOff = async (): Promise<boolean> => (await deps.handedOff?.().catch(() => false)) ?? false

  async function close(why: string): Promise<void> {
    const ep = episode!
    episode = null
    await save()
    try { await deps.archive({ ...(ep.letterId ? { letterId: ep.letterId } : {}), opKey: ep.opKey }) } catch (err) {
      log.session.warn('ssh certificate letter could not be archived', { letterId: ep.letterId, error: err instanceof Error ? err.message : String(err) })
    }
    log.session.info('ssh certificate letter archived', { letterId: ep.letterId, why })
  }

  /** The expired turn, once: into the letter, with what ssh said. */
  async function tellExpired(error?: string): Promise<void> {
    const ep = episode
    if (!ep?.letterId || ep.expiredTold) return
    await deps.addTurn(ep.letterId, sshCertExpiredTurn(await lang(), {
      hosts: ep.labels.length ? ep.labels : ep.hosts, expiresAt: ep.expiresAt, ...(error ? { error } : {}), hint: await hint(),
    }))
    ep.expiredTold = true
    await save()
    log.session.warn('ssh certificate expired: turn added to its letter', { letterId: ep.letterId, hosts: ep.hosts })
  }

  async function send(): Promise<void> {
    const ep = episode!
    const { subject, markdown } = SSH_CERT_EXPIRY.render(await lang(), {
      hosts: ep.labels.length ? ep.labels : ep.hosts, expiresAt: ep.expiresAt, now: now(), hint: await hint(),
    })
    ep.letterId = await deps.send({ subject, markdown, opKey: ep.opKey })
    await save()
    log.session.warn('ssh certificate expires soon: letter sent', { letterId: ep.letterId, hosts: ep.hosts, expiresAt: new Date(ep.expiresAt).toISOString() })
  }

  function check(): Promise<void> {
    return serial(async () => {
      try { await checkOnce() } catch (err) {
        // A step that failed (a store write, a config read) tries again soon: the clock never stops.
        arm(NEAR_EVERY_MS)
        throw err
      }
    }, undefined)
  }

  async function checkOnce(): Promise<void> {
    await loaded
    if (await handedOff()) {
      if (episode) await close('another reminder owns the certificate')
      arm(CHECK_EVERY_MS)
      return
    }
    const hosts = await deps.hosts()
    const byHost = new Map(hosts.map((h) => [h.host, h] as const))
    const expiry = new Map<string, number>()
    for (const h of hosts) {
      // Infinity (valid forever) proves a renewal; it never opens an episode.
      const at = await deps.certExpiry(h.host).catch(() => null)
      if (at !== null) expiry.set(h.host, at)
    }
    if (episode) {
      // A host gone from Settings leaves it; with none left, nothing waits on the letter.
      episode.hosts = episode.hosts.filter((h) => byHost.has(h))
      if (episode.hosts.length === 0) { await close('its hosts left Settings'); arm(CHECK_EVERY_MS); return }
      // Renewed: the certificate its hosts use now outlives the one the letter is about.
      // A host whose certificate could not be read says nothing either way.
      const known = episode.hosts.filter((h) => expiry.has(h))
      if (known.length > 0 && known.every((h) => expiry.get(h)! > episode!.expiresAt + SAME_CERT_MS)) await close('a renewed certificate is in place')
    }
    if (!episode) {
      const soonest = Math.min(...[...expiry.values()].filter(Number.isFinite))
      if (!Number.isFinite(soonest) || soonest - now() > warnAhead) { arm(CHECK_EVERY_MS); return }
      const same = hosts.filter((h) => expiry.has(h.host) && Math.abs(expiry.get(h.host)! - soonest) <= SAME_CERT_MS)
      episode = {
        opKey: letterOpKey(SSH_CERT_EXPIRY.id, String(soonest)),
        expiresAt: soonest, hosts: same.map((h) => h.host), labels: same.map((h) => h.label || h.host), openedAt: now(),
      }
      await save()
    }
    if (!episode.letterId) {
      try { await send() } catch (err) {
        log.session.warn('ssh certificate letter could not be sent; trying again', { error: err instanceof Error ? err.message : String(err) })
        arm(NEAR_EVERY_MS)
        return
      }
    }
    // Past the expiry: a fresh sign-in says whether it really stopped working.
    if (now() >= episode.expiresAt && !episode.expiredTold && !episode.signInWorks) {
      const probe = await deps.freshSignIn(episode.hosts[0]!).catch((err) => ({ ok: false, unknown: true, error: err instanceof Error ? err.message : String(err) }))
      if (probe.ok) {
        // It still signs in without that certificate: nothing to renew, the letter goes.
        episode.signInWorks = true
        await save()
        try { await deps.archive({ ...(episode.letterId ? { letterId: episode.letterId } : {}), opKey: episode.opKey }) } catch { /* the renewal or hosts check archives it later */ }
        log.session.info('ssh certificate expired but a fresh sign-in works: letter archived', { letterId: episode.letterId })
      } else if (!probe.unknown) await tellExpired(probe.error)
    }
    const done = episode.expiredTold || episode.signInWorks
    arm(done ? CHECK_EVERY_MS : Math.max(5_000, Math.min(NEAR_EVERY_MS, episode.expiresAt - now() + 5_000)))
  }

  return {
    start: () => arm(FIRST_CHECK_MS),
    check,
    episode: async () => { await chain; await loaded; return episode },
    joinLetter: (hosts, error) => serial(async () => {
      await loaded
      if (await handedOff()) return null
      if (!episode?.letterId || episode.signInWorks || !hosts.some((h) => episode!.hosts.includes(h))) return null
      if (now() >= episode.expiresAt) await tellExpired(error)
      return episode.letterId
    }, null),
    stop: () => { stopped = true; if (timer) clearTimer(timer); timer = null },
  }
}

// ── Server wiring ──

let running: CertExpiryAlert | null = null

/** The running alert (host-auth-alert.ts joins its letter), or null. */
export function runningCertExpiryAlert(): CertExpiryAlert | null {
  return running
}

/**
 * Watch the SSH certificates of the configured remote hosts (primary only, next to
 * startHostAuthAlert). `WALNUT_SSH_CERT_LETTER=0` turns it off; so does the host fixture.
 */
export async function startCertExpiryAlert(opts: { enabled?: boolean }): Promise<() => void> {
  if (opts.enabled === false || process.env.WALNUT_SSH_CERT_LETTER === '0') return () => {}
  // A test server never runs a real ssh (the exec guard refuses it), unless a check asks for this one.
  if (process.env.VITEST && process.env.WALNUT_SSH_CERT_LETTER !== '1') return () => {}
  const { findLetterByOp, sendLetterOnce, setArchived, agentReply } = await import('../human-inbox/store.js')
  const { getConfig } = await import('../config-manager.js')
  const { walnutLetterLanguage } = await import('../human-inbox/walnut-letters/languages.js')
  const { linkTarget } = await import('./link.js')
  const { CLOUD_BOX_HOST_ALIAS } = await import('./cloud-box-host.js')
  const { sshCertificateExpiry } = await import('../../providers/ssh-credential-evidence.js')
  const { execFile } = await import('node:child_process')
  const targetOf = async (host: string): Promise<{ dest: string; port?: number } | null> => {
    const t = linkTarget(host, await getConfig())
    if (t.via === 'net' || !t.hostname) return null
    return { dest: t.user ? `${t.user}@${t.hostname}` : t.hostname, ...(t.port ? { port: t.port } : {}) }
  }
  const alert = createCertExpiryAlert({
    hosts: async () => {
      const hosts = (await getConfig()).hosts ?? {}
      return Object.entries(hosts)
        .filter(([key, def]) => key !== '__local__' && key !== CLOUD_BOX_HOST_ALIAS && def.enabled !== false && (def as { transport?: string }).transport !== 'net')
        .map(([key, def]) => ({ host: key, label: (def as { label?: string }).label || key }))
    },
    certExpiry: async (host) => {
      const t = await targetOf(host)
      return t ? sshCertificateExpiry(t.dest) : null
    },
    freshSignIn: async (host) => {
      const t = await targetOf(host)
      if (!t) return { ok: false, unknown: true }
      const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=15',
        '-o', 'ControlMaster=no', '-o', 'ControlPath=none', ...(t.port ? ['-p', String(t.port)] : []), t.dest, 'true']
      return new Promise((resolve) => {
        execFile('ssh', args, { timeout: 30_000, encoding: 'utf-8' }, (err, _stdout, stderr) => {
          if (!err) { resolve({ ok: true }); return }
          const said = String(stderr ?? '').trim() || (err instanceof Error ? err.message : String(err))
          // Only a refused sign-in is the certificate's; a host that is down says nothing of it.
          resolve(/permission denied|certificate|publickey/i.test(said) ? { ok: false, error: said.slice(0, 300) } : { ok: false, unknown: true })
        })
      })
    },
    send: async ({ subject, markdown, opKey }) => (await sendLetterOnce({
      subject, type: 'review', markdown, sender: { sessionId: 'external', host: 'local' },
    }, { opKey })).letter.id,
    addTurn: async (letterId, text) => { await agentReply(letterId, { text }) },
    archive: async ({ letterId, opKey }) => {
      const id = letterId ?? (await findLetterByOp(opKey))?.id
      if (id) await setArchived(id, true)
    },
    loginHint: async () => {
      const hint = (await getConfig()).ssh_login_hint
      return typeof hint === 'string' ? hint : undefined
    },
    handedOff: async () => (await getConfig()).ssh_cert_letter === false,
    language: walnutLetterLanguage,
  })
  running = alert
  alert.start()
  return () => {
    alert.stop()
    if (running === alert) running = null
  }
}
