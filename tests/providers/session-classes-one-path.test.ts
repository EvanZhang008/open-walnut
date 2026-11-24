/**
 * One path for every session, whoever is its host (docs/plan/one-service-every-host.md, phase 2):
 * the leader's own machine's sessions and the sessions a host's one service runs and judges go
 * through the SAME session classes (ClaudeCodeSession, SessionRunner, AcpSession and the Codex
 * app-server engine), with only the session port (sessions/session-port.ts) wired to the data of
 * the server they run in. The leader is the host of its own machine's sessions: its judge label for
 * them is 'here' (sessions/judge-of.ts), and nothing in the classes may tell those sessions apart
 * from a host's own.
 *
 * Two ways such a split appears, both counted here from the source:
 *
 *   1. The row's raw `host` read as a place. On a host that runs its sessions an own row names the
 *      host's key, so `record.host ?? '__local__'` takes the remote branch for a session that runs
 *      right there (until 2026-11-24 a dozen sites did: the reconnect redelivery, cancelled-row
 *      recovery, the resume MCP mount, the rewind probe, the told-line stat). The classes ask
 *      session-row-owner.ts `execHostOf` / `cliHostOf` instead. A raw read is allowed only as a
 *      `host:` field carried as data (a log line, an event's payload) or where it is listed below.
 *   2. A branch on what this server is (leader, replica, companion) or on who judges a session.
 *      Each one in the class files is listed with why; a new one fails until it says why it is not
 *      a second path for the leader's own sessions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const role = vi.hoisted(() => ({ replica: false }))
vi.mock('../../src/core/server-role.js', async (orig) => ({ ...(await orig<typeof import('../../src/core/server-role.js')>()), isHostReplica: () => role.replica }))
const { cliHostOf, execHostOf } = await import('../../src/core/sessions/session-row-owner.js')

const ROOT = path.resolve(import.meta.dirname, '..', '..')

/** The session classes' files (the same list as tests/core/sessions/session-port-ratchet.test.ts). */
function sessionClassFiles(): string[] {
  const codex = fs.readdirSync(path.join(ROOT, 'src/providers/codex-app-server'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `src/providers/codex-app-server/${f}`)
  return ['src/providers/claude-code-session.ts', 'src/providers/acp-session.ts', ...codex]
}

/** Comment lines blanked, so a sentence about `record.host` is not code. */
function codeLines(source: string): string[] {
  return source.split('\n').map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l))
}

/** A session record's own variable names in the classes. */
const ROW_HOST = /\b(?:record|rec|row|existing|stored|prior)\??\.host\b/g

/** Raw reads of a row's host that are right as they are: file, the call's text on its line, why. */
const RAW_HOST_ALLOWED: Array<{ file: string; text: string; why: string }> = [
  {
    file: 'src/providers/claude-code-session.ts',
    text: 'getHostModelCatalog(record.host)',
    why: 'the model catalog is kept under the leader\'s name for the machine (the catalog it probed there), the right key on the leader and on that host',
  },
]

/** Predicates that ask what this server is or who judges a session. */
const ROLE_ASK = /\b(?:isHostReplica|isFollower|isCompanion|followerKind|role|placement|hasLocalDaemon|isLeader|leaderAnswers|runsSessions|judgeOf|judgeOfStart|judgedHere|judgeOfRecord|judgedHereRecords|thisHostKey|judgingHostOf|taskSideOnLeader|hostStandsDown)\(|\b(?:CLOUD_MODE|IS_EPHEMERAL)\b/g

/** Each such ask in the class files, by file and name: how many, and why none is a local-only path. */
const ROLE_ASKS: Record<string, Record<string, { count: number; why: string }>> = {
  'src/providers/claude-code-session.ts': {
    'thisHostKey(': { count: 2, why: 'with rowOwnedHere: a host\'s own row read on from the line its leader was last told (attachToExisting), and attachOwnLive; both exist only where the judge and the leader are two processes, and the leader\'s own sessions have no told line to read on from' },
    'hostStandsDown(': { count: 1, why: 'the same told-line replay, off while a host stands down for an older leader' },
    'isCompanion(': { count: 2, why: 'the Walnut MCP mount at a start and a resume: the companion has no machine of its own for a CLI to mount a local server on' },
    'judgingHostOf(': { count: 1, why: 'the leader\'s runner hands a host-judged session to its host (host-judged-runner.ts): the proxy branch, not a path of the leader\'s own sessions' },
    'CLOUD_MODE': { count: 1, why: 'a local start on the companion names no machine of its own (the start\'s place resolution)' },
  },
}

describe('the session classes run every session on one path, whoever is its host', () => {
  const files = sessionClassFiles()

  it('read a session\'s machine through execHostOf/cliHostOf, never the row\'s raw host', () => {
    const bad: string[] = []
    const used = new Set<string>()
    for (const file of files) {
      const lines = codeLines(fs.readFileSync(path.join(ROOT, file), 'utf8'))
      lines.forEach((line, i) => {
        for (const m of line.matchAll(ROW_HOST)) {
          const at = m.index ?? 0
          // Carried as data: `host: record.host` (a log field, an event's payload).
          if (/\bhost:\s*$/.test(line.slice(0, at))) continue
          const allowed = RAW_HOST_ALLOWED.find((a) => a.file === file && line.includes(a.text))
          if (allowed) { used.add(`${allowed.file}|${allowed.text}`); continue }
          bad.push(`${file}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    expect(bad, `a row's raw host read as a place: ask execHostOf(record) (undefined for this machine) or cliHostOf(record) ('__local__' for this machine) instead:\n${bad.join('\n')}`).toEqual([])
    // A listed read that is gone is taken off the list.
    expect(RAW_HOST_ALLOWED.filter((a) => !used.has(`${a.file}|${a.text}`)).map((a) => `${a.file}: ${a.text}`)).toEqual([])
  })

  it('ask what this server is, or who judges a session, only where it is listed with why', () => {
    const found: Record<string, Record<string, number>> = {}
    for (const file of files) {
      const lines = codeLines(fs.readFileSync(path.join(ROOT, file), 'utf8'))
      for (const line of lines) {
        // An import names a predicate without asking it.
        if (/^\s*import\b/.test(line)) continue
        for (const m of line.matchAll(ROLE_ASK)) {
          const name = m[0]
          ;(found[file] ??= {})[name] = ((found[file] ??= {})[name] ?? 0) + 1
        }
      }
    }
    const want = Object.fromEntries(Object.entries(ROLE_ASKS).map(([f, names]) => [f, Object.fromEntries(Object.entries(names).map(([n, v]) => [n, v.count]))]))
    expect(found, 'a new ask of what this server is (or who judges a session) in the session classes: a second path for the leader\'s own sessions unless ROLE_ASKS says why it is not').toEqual(want)
  })

  describe('cliHostOf: the daemon link that reaches a session\'s CLI from this server', () => {
    afterEach(() => { role.replica = false; delete process.env.WALNUT_HOST_KEY })

    it('on the leader: this machine for its own rows, the host for every other', () => {
      for (const host of [undefined, '', '__local__']) expect(cliHostOf({ host })).toBe('__local__')
      expect(cliHostOf(null)).toBe('__local__')
      expect(cliHostOf({ host: 'devbox' })).toBe('devbox')
      expect(cliHostOf({ judge: 'host', host: 'devbox' })).toBe('devbox')
    })

    it('on a host that runs its sessions: this machine for its own rows too, exactly as the leader\'s own', () => {
      role.replica = true
      process.env.WALNUT_HOST_KEY = 'devbox'
      expect(cliHostOf({ judge: 'host', host: 'devbox' })).toBe('__local__')
      expect(execHostOf({ judge: 'host', host: 'devbox' })).toBeUndefined()
      // A copy of another's row keeps naming where that session runs.
      expect(cliHostOf({ host: 'devbox' })).toBe('devbox')
      expect(cliHostOf({ judge: 'host', host: 'other' })).toBe('other')
    })
  })
})
