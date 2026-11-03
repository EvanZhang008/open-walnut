/**
 * Whether this process still lives in a working login session, and a working
 * directory that still exists.
 *
 * 2026-11-03: the Mac's WindowServer crashed and macOS logged the user out. A
 * deploy that ran in those seconds could not load its launchd job (the session's
 * domain was going away), fell back to nohup, and its server lived on in the
 * ended session: every lookup that goes through the session's system services
 * failed from then on. ssh said "No user exists for uid 503" (getpwuid), the DNS
 * resolver had no configuration, and the server's working directory was the
 * deploy's build clone, deleted when the deploy ended, so a child that asked for
 * its cwd (the voice model's Python) died with FileNotFoundError. Each feature
 * reported its own errno; nothing said why.
 *
 * Three signals, each read from what the system answers, never from a time:
 *   user_lookup : `id -un` prints the uid instead of a name (getpwuid failed)
 *   dns_config  : `scutil --dns` says "No DNS configuration available" (macOS)
 *   cwd_gone    : the working directory's path no longer names the directory
 * A process cannot move itself into a new login session, so the first two are
 * reported (the server log, GET /api/config `loginSession`), and the processes
 * that do live in the new session act on them: the Mac app replaces a server
 * that reports them (desktop/main.swift), and a server in a working session
 * replaces a local daemon that reports them (local-daemon.ts). The third one a
 * process fixes itself: healCwd() moves it to the home directory, so no child it
 * starts afterwards inherits a deleted directory.
 */
import fs from 'node:fs'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { log } from '../logging/index.js'

export type LoginSessionProblem = 'user_lookup' | 'dns_config' | 'cwd_gone'

export interface LoginSessionState {
  ok: boolean
  problems: LoginSessionProblem[]
  /** When the probe last ran (ISO), null before the first one. */
  checkedAt: string | null
  /** What the user reads: one sentence naming the cause and the way out. */
  summary?: string
  /** Where healCwd moved the process after its working directory was deleted. */
  movedTo?: string
}

/** The signals every probe reads; a guard test checks each has a judge and words. */
export const LOGIN_SESSION_PROBLEMS: readonly LoginSessionProblem[] = ['user_lookup', 'dns_config', 'cwd_gone']

/** The commands whose output judgeLoginSession reads, run in one shell. */
export const LOGIN_SESSION_PROBE_SCRIPT = "echo '--walnut-id--'; /usr/bin/id -un 2>&1; echo '--walnut-dns--'; if [ -x /usr/sbin/scutil ]; then /usr/sbin/scutil --dns 2>&1 | /usr/bin/head -3; fi"

const ID_MARK = '--walnut-id--'
const DNS_MARK = '--walnut-dns--'

/**
 * The problems the probe's output shows. Unknown is never a problem: a command
 * that did not run (no output) says nothing about the session.
 */
export function judgeLoginSession(facts: { uid: number; probeOutput: string | null; cwdExists: boolean }): LoginSessionProblem[] {
  const problems: LoginSessionProblem[] = []
  // Only what follows the marks: a login shell the probe ran under may print first.
  const raw = facts.probeOutput ?? ''
  const from = raw.lastIndexOf(ID_MARK)
  const out = from < 0 ? '' : raw.slice(from + ID_MARK.length)
  const at = out.indexOf(DNS_MARK)
  const idPart = (at < 0 ? out : out.slice(0, at)).trim()
  const dnsPart = at < 0 ? '' : out.slice(at + DNS_MARK.length)
  // getpwuid failed: `id -un` falls back to the number, or says there is no such user.
  if (idPart && (idPart === String(facts.uid) || /no such user/i.test(idPart))) problems.push('user_lookup')
  if (/No DNS configuration available/i.test(dnsPart)) problems.push('dns_config')
  if (!facts.cwdExists) problems.push('cwd_gone')
  return problems
}

const WORDS: Record<LoginSessionProblem, string> = {
  user_lookup: 'it cannot look up its own user (ssh to other hosts fails with "No user exists for uid")',
  dns_config: 'it has no DNS configuration (names on the network do not resolve)',
  cwd_gone: 'its working directory was deleted',
}

/** One sentence for the log and the Mac app. */
export function loginSessionSummary(problems: readonly LoginSessionProblem[]): string | undefined {
  const session = problems.filter((p) => p !== 'cwd_gone')
  if (!problems.length) return undefined
  const what = problems.map((p) => WORDS[p]).join('; ')
  return session.length
    ? `This Walnut server runs in a login session that has ended (macOS logged the user out while it ran): ${what}. `
      + 'Opening the Walnut app restarts it in the current session; without the app, run `walnut web` (or the deploy) again from a new Terminal window.'
    : `This Walnut server's ${what}; it moved to the home directory.`
}

/** Whether the path the process reports as its cwd still names the directory it is in. */
export function cwdStillExists(): boolean {
  let cwd: string
  try { cwd = process.cwd() } catch { return false }
  try {
    const here = fs.statSync('.')
    const there = fs.statSync(cwd)
    return here.ino === there.ino && here.dev === there.dev
  } catch {
    return false
  }
}

/**
 * Move a process whose working directory was deleted to one that exists: the
 * home directory, else the temp dir, else `/`. Returns the new cwd, or null when
 * the old one was fine (or no move worked).
 */
export function healCwd(): string | null {
  if (cwdStillExists()) return null
  const was = (() => { try { return process.cwd() } catch { return '(unknown)' } })()
  for (const dir of [process.env.HOME, os.homedir(), os.tmpdir(), '/']) {
    if (!dir) continue
    try {
      process.chdir(dir)
      log.web.warn('working directory was deleted; moved to one that exists', { was, now: dir })
      return dir
    } catch { /* next */ }
  }
  return null
}

function runProbe(timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', LOGIN_SESSION_PROBE_SCRIPT], { timeout: timeoutMs, cwd: '/', encoding: 'utf8' }, (err, stdout) => {
      resolve(typeof stdout === 'string' && stdout.length ? stdout : err ? null : '')
    })
  })
}

let state: LoginSessionState = { ok: true, problems: [], checkedAt: null }
let timer: ReturnType<typeof setInterval> | null = null
let running: Promise<LoginSessionState> | null = null
let lastSeen: LoginSessionProblem[] = []

export function loginSessionState(): LoginSessionState {
  return state
}

/** What the last probe saw, confirmed or not: whether this process may act for others now. */
export function loginSessionSeen(): readonly LoginSessionProblem[] {
  return lastSeen
}

/** Run the probe now (one at a time), heal the cwd, record and log a change. */
export function checkLoginSession(opts: { timeoutMs?: number; probe?: () => Promise<string | null> } = {}): Promise<LoginSessionState> {
  if (running) return running
  // Cleared after it settles (never inside it: a pass with no await would clear
  // it before the assignment, and every later check would get the first answer).
  const pass = (async () => {
    const healed = healCwd()
    // Only macOS ends a login session under a running process this way; elsewhere
    // the cwd is the one signal that applies.
    const probeOutput = opts.probe ? await opts.probe() : process.platform === 'darwin' ? await runProbe(opts.timeoutMs ?? 5_000) : null
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1
    // After healCwd, cwd_gone means no directory could be moved to.
    const seen = judgeLoginSession({ uid, probeOutput, cwdExists: cwdStillExists() })
    // A session problem counts once two probes in a row see it: one failed lookup
    // while the system is busy is not an ended session, and the Mac app replaces a
    // server that reports one.
    const problems = seen.filter((p) => p === 'cwd_gone' || lastSeen.includes(p))
    lastSeen = seen
    const next: LoginSessionState = {
      ok: problems.length === 0, problems, checkedAt: new Date().toISOString(),
      ...(problems.length ? { summary: loginSessionSummary(problems) } : {}),
      ...(healed ? { movedTo: healed } : state.movedTo ? { movedTo: state.movedTo } : {}),
    }
    if (next.problems.join(',') !== state.problems.join(',')) {
      if (problems.length) log.web.error('login session ended under this server', { problems, summary: next.summary })
      else if (state.checkedAt) log.web.info('login session works again', {})
    }
    state = next
    return state
  })()
  running = pass
  void pass.finally(() => { if (running === pass) running = null }).catch(() => {})
  return pass
}

/**
 * The problems two probes in a row see, for a check that does not keep a
 * monitor (a server asking about its local daemon): `probe` runs twice, `gapMs` apart.
 */
export async function confirmedProblems(probe: () => Promise<string | null>, uid: number, gapMs = 2_000): Promise<LoginSessionProblem[]> {
  const first = judgeLoginSession({ uid, probeOutput: await probe(), cwdExists: true })
  if (!first.length) return []
  await new Promise((r) => setTimeout(r, gapMs))
  const second = judgeLoginSession({ uid, probeOutput: await probe(), cwdExists: true })
  return first.filter((p) => second.includes(p))
}

/** At boot, then every `intervalMs`: the server's own check. Never keeps the process alive. */
export function startLoginSessionMonitor(intervalMs = 60_000): void {
  if (timer) return
  void checkLoginSession().catch(() => {})
  timer = setInterval(() => { void checkLoginSession().catch(() => {}) }, intervalMs)
  timer.unref?.()
}

export function stopLoginSessionMonitor(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** Tests: start from a clean state. */
export function resetLoginSessionForTest(): void {
  stopLoginSessionMonitor()
  state = { ok: true, problems: [], checkedAt: null }
  running = null
  lastSeen = []
}
