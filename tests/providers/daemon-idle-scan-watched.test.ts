/**
 * The idle scan never stops a session whose subscribers only just left (or that has not been
 * subscribed to yet): idleness counts from the later of its last output and the last time someone
 * watched it (Subscribers.watchedAt).
 *
 * 2026-11-23, clouddev: a Mac deploy dropped the leader's link for 10 s (12:10:04 to 12:10:14),
 * which took the leader off all 54 sessions' subscribers; the scan at 12:10:16 stopped the 17 of
 * them idle 2 to 4 hours, while the leader subscribed to them again within the minute. The same
 * happened on every deploy before (13 stops on one morning, 20 on 11-20).
 *
 * The daemon is exercised from its own text: Subscribers and scanIdleSessions are sliced out of
 * daemon-standalone.ts and evaluated with every free identifier injected. The kill is a spy; no process, file or socket is touched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import nodeFs from 'node:fs'
import nodePath from 'node:path'
import ts from 'typescript'

const REPO_ROOT = nodePath.resolve(__dirname, '../..')
const SID = '11111111-2222-4333-8444-555555555555'
/** Above any real pid limit: nothing can ever answer to it. */
const PID = 2 ** 22 + 17
const JSONL = `/fixture/streams/${SID}.jsonl`
const MIN = 60_000
const IDLE_WARNING_MS = 5 * MIN
const IDLE_KILL_MS = 120 * MIN
const T0 = Date.UTC(2026, 10, 23, 12, 0, 0)

const DAEMON_SRC = nodeFs.readFileSync(nodePath.join(REPO_ROOT, 'src/providers/daemon-standalone.ts'), 'utf-8')

function sliceTopLevel(src: string, head: RegExp, name: string): string {
  const at = src.search(head)
  expect(at, `${name} not found`).toBeGreaterThan(-1)
  const end = src.indexOf('\n}', at)
  expect(end).toBeGreaterThan(at)
  return src.slice(at, end + 2)
}

function buildDaemon(mtimeMs: number) {
  const kills: number[] = []
  const sessions = new Map<string, Record<string, unknown>>()
  const injected: Record<string, unknown> = {
    sessions,
    SERVICE_MODE: true,
    daemonCommands: { closed: false },
    codeServer: { reapIdleCodeServer: () => false },
    isProcessGroupAlive: () => false,
    killProcessGroup: () => { throw new Error('killProcessGroup must not run here') },
    process: { kill: (pid: number, sig: number) => { if (pid !== PID || sig !== 0) throw new Error('unexpected signal') } },
    reapSession: () => { throw new Error('reapSession must not run here') },
    fs: {
      utimesSync: () => {},
      statSync: (p: string) => { if (p !== JSONL) throw new Error('ENOENT'); return { mtimeMs } },
    },
    deriveSessionProtection: () => ({ source: null, killMs: IDLE_KILL_MS }),
    hasRecentSchedulerFiring: () => false,
    SESSION_IDLE_WARNING_MS: IDLE_WARNING_MS,
    SESSION_IDLE_KILL_MS: IDLE_KILL_MS,
    logMsg: () => {},
    killSessionProcessGroup: (pid: number) => { kills.push(pid) },
  }
  const src = DAEMON_SRC
  const code = sliceTopLevel(src, /class Subscribers(<T>)? extends Set/, 'Subscribers') + '\n'
    + sliceTopLevel(src, /function scanIdleSessions\(/, 'scanIdleSessions')
  const js = ts.transpileModule(code + '\nreturn { Subscribers, scanIdleSessions };', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const names = Object.keys(injected)
  const built = new Function(...names, js)(...names.map((n) => injected[n])) as {
    Subscribers: new () => Set<unknown> & { watchedAt: number }
    scanIdleSessions: () => void
  }
  /** A session as a start or an adoption makes it: a fresh Subscribers, nobody attached yet. */
  const addSession = () => {
    const session = { pid: PID, exitCode: null, jsonlPath: JSONL, pgidPath: '/fixture/x.pgid', subscribers: new built.Subscribers() }
    sessions.set(SID, session)
    return session
  }
  return { ...built, addSession, kills }
}

describe('idle scan and Subscribers', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0) })
  afterEach(() => { vi.useRealTimers() })
  const at = (min: number) => vi.setSystemTime(T0 + min * MIN)

  it('a leader link that drops stops no session: the subscriber that just left still counts', () => {
    const daemon = buildDaemon(T0 - 244 * MIN)   // last output 4 h ago, like the stopped sessions
    const session = daemon.addSession()
    const leader = {}
    at(1); session.subscribers.add(leader)
    at(6); daemon.scanIdleSessions()
    expect(daemon.kills, 'a watched session is never idle').toEqual([])
    session.subscribers.delete(leader)             // the link drops
    at(6.2); daemon.scanIdleSessions()
    expect(daemon.kills, 'stopped 12 s after its subscriber left').toEqual([])
    at(6 + 119); daemon.scanIdleSessions()
    expect(daemon.kills, 'stopped before 2 h without anyone watching').toEqual([])
  })

  it('a session nobody watches or writes for the whole threshold is still reclaimed', () => {
    const daemon = buildDaemon(T0 - 244 * MIN)
    const session = daemon.addSession()
    const leader = {}
    session.subscribers.add(leader)
    at(10); session.subscribers.delete(leader)
    at(10 + 121); daemon.scanIdleSessions()
    expect(daemon.kills).toEqual([PID])
  })

  it('an adopted session is not stopped before the leader attaches', () => {
    const daemon = buildDaemon(T0 - 244 * MIN)
    daemon.addSession()                               // adoption at service start: no subscriber yet
    at(1); daemon.scanIdleSessions()
    at(30); daemon.scanIdleSessions()
    expect(daemon.kills).toEqual([])
  })

  it('only the last subscriber leaving moves watchedAt; clear() of a watched set moves it too', () => {
    const daemon = buildDaemon(T0)
    const s = new daemon.Subscribers()
    expect(s.watchedAt).toBe(T0)
    const a = {}; const b = {}
    s.add(a); s.add(b)
    at(5); s.delete(a)
    expect(s.watchedAt, 'one subscriber still watches').toBe(T0)
    at(6); s.delete({})
    expect(s.watchedAt, 'deleting a stranger changes nothing').toBe(T0)
    at(7); s.delete(b)
    expect(s.watchedAt).toBe(T0 + 7 * MIN)
    at(8); s.clear()
    expect(s.watchedAt, 'clearing an empty set changes nothing').toBe(T0 + 7 * MIN)
    s.add(a); at(9); s.clear()
    expect(s.watchedAt).toBe(T0 + 9 * MIN)
  })
})

describe('every session subscriber set remembers when it was last watched', () => {
  it('each session is built with Subscribers, never a plain Set', () => {
    const src = DAEMON_SRC
    const built = src.match(/subscribers\s*[:=]\s*new\s+\w+/g) ?? []
    expect(built.length, 'no session construction found').toBeGreaterThan(0)
    // A new place that builds a session with a plain Set brings the 2026-11-23 stops back.
    expect(built.filter((m) => !/new\s+Subscribers$/.test(m))).toEqual([])
    expect(src).toMatch(/Math\.max\(mtimeMs, session\.subscribers\.watchedAt/)
  })
})
