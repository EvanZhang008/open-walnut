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
const { cliHostOf, execHostOf, readHostOf } = await import('../../src/core/sessions/session-row-owner.js')

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

/**
 * 3. Beyond the classes: every file under src/ that decides a session's place (a daemon link, a file
 *    reader, a probe, local or remote) from a row's raw `host`. On a host that runs its sessions an own
 *    row names the host's key, so such a read sends this machine's own session to a link of that name,
 *    which reaches nothing here (until 2026-11-24 the stop flush, the reconnect rescue, the agent-wait
 *    resend, the liveness and stale checks, the history and cost readers all did). The forms counted:
 *    `x.host ?? '__local__'` and `|| '__local__'`, `x.host === / !== '__local__'`, `!x.host`, and a raw
 *    `x.host` handed to a link or reader. A file that keeps one names why it is not a session's place.
 *    Two answers, by what is reached: the CLI's pooled connection is cliHostOf/execHostOf (on a host,
 *    '__local__', its own-sessions link); a read of the session's files through hosts/link.ts is
 *    readHostOf, the row's own name (on a host, its follower link: link.ts refuses '__local__' there).
 */
const ROW = String.raw`(?:record|rec|row|existing|current|stored|prior|session|s|r|caller\.record|p\.session)`
const PLACE_FROM_ROW = new RegExp(String.raw`\b${ROW}\??\.host\s*(?:\?\?|\|\|)\s*'__local__'|\b${ROW}\??\.host\s*(?:===|!==)\s*'__local__'|!${ROW}\??\.host\b|\b(?:getConnectedDaemonConnection|getPooledSnapshotConnection|isDaemonConnected|probeDaemonSession|DaemonFileReader|statStreamFile|readSessionJsonlContent|taskDirForHost|invalidateSessionHistoryCaches|hostConnection)\(\s*${ROW}\??\.host\b`, 'g')

const KEYS_BY_NAME = 'keyed by the machine\'s name as the leader names it (usage, windows, picks), not a link'
/** The files that read a row's raw host in those forms, how many times, and why none is a session's place. */
const RAW_PLACE_ALLOWED: Record<string, { count: number; why: string }> = {
  'src/commands/demo-server.ts': { count: 3, why: 'the demo server picks the seeded rows it shows by host name; no session runs there' },
  'src/core/frequent-dirs.ts': { count: 2, why: `the folders a person picked, ${KEYS_BY_NAME}` },
  'src/core/hosts/found-host-alert.ts': { count: 1, why: 'a host phase event names a host, not a session row' },
  'src/core/human-inbox/credential-ask.ts': { count: 1, why: 'a credential ask names a host by name, not a session row' },
  'src/core/human-inbox/letter-check.ts': { count: 1, why: 'a credential ask names a host by name, not a session row' },
  'src/core/router/session-policy.ts': { count: 1, why: 'a router area is matched by the machine name the area names' },
  'src/core/session-tracker.ts': { count: 1, why: 'handSeedToHost compares a start seed\'s host name with the host it is handed to (two names of one machine): names, not a place' },
  'src/core/sessions/judge-of.ts': { count: 1, why: 'the boot seed of host-judged ACP runtimes skips a row of no host or of this host\'s own key: names, not a place' },
  'src/core/session-db.ts': { count: 1, why: 'a start claims a row of no host or of this host\'s key: it compares the row with that key itself' },
  'src/core/sessions/cloud-chat-lane.ts': { count: 1, why: 'the companion\'s own chat lanes, which run on no host' },
  'src/core/sessions/engine-switch-context.ts': { count: 1, why: `a model window learned on a machine, ${KEYS_BY_NAME}` },
  'src/core/sessions/external-session-import.ts': { count: 1, why: `a retitle list ${KEYS_BY_NAME}` },
  'src/core/subagents/on-host.ts': { count: 1, why: 'a Walnut subagent\'s own record (its host alias \'local\'), not a session row' },
  'src/core/subagents/registry.ts': { count: 1, why: 'a Walnut subagent\'s own record (its host alias \'local\'), not a session row' },
  'src/core/time-tracking/report-adjust.ts': { count: 2, why: 'a time record\'s host name, not a session row' },
  'src/core/transcript-archive-sweep.ts': { count: 1, why: `archive rows ${KEYS_BY_NAME}` },
  'src/core/usage/collection.ts': { count: 5, why: `usage per machine, ${KEYS_BY_NAME}` },
  'src/core/usage/session-budget.ts': { count: 1, why: `runtime ids grouped by the budget's machine, ${KEYS_BY_NAME}` },
  'src/providers/host-resume.ts': { count: 4, why: 'a legacy row\'s host name, read on the leader to hand its resume to that host (host-judged rows are left out first)' },
  'src/providers/model-window-store.ts': { count: 1, why: `model windows ${KEYS_BY_NAME}` },
  'src/web/routes/session-control-v1.ts': { count: 1, why: 'the companion\'s copy row names the host the companion may lead' },
  'src/web/routes/session-stop-v1.ts': { count: 1, why: 'a label: the name of the session\'s machine for a sentence' },
  'src/web/terminal/dtach-check.ts': { count: 1, why: 'a terminal ref names the machine its terminal opens on; it carries no judge' },
  'src/web/terminal/dtach-lifecycle.ts': { count: 2, why: 'a terminal ref names the machine its terminal opens on; it carries no judge' },
  'src/web/terminal/spawn.ts': { count: 2, why: 'a terminal ref names the machine its terminal opens on; it carries no judge' },
}

function srcFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.posix.join(dir, e.name)
    if (e.isDirectory()) return srcFiles(rel)
    return /\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [rel] : []
  })
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

  it('every file under src/ decides a session\'s place through execHostOf/cliHostOf, or says why its raw host is no place', () => {
    const found: Record<string, number> = {}
    const where: string[] = []
    for (const file of srcFiles('src')) {
      if (file === 'src/core/sessions/session-row-owner.ts') continue
      codeLines(fs.readFileSync(path.join(ROOT, file), 'utf8')).forEach((line, i) => {
        for (const m of line.matchAll(PLACE_FROM_ROW)) {
          // Carried as data: `host: x.host ?? '__local__'` (a log field, an event's payload).
          if (/\bhost:\s*$/.test(line.slice(0, m.index ?? 0))) continue
          found[file] = (found[file] ?? 0) + 1
          where.push(`${file}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    const want = Object.fromEntries(Object.entries(RAW_PLACE_ALLOWED).map(([f, v]) => [f, v.count]))
    expect(found, `a session's place read from its row's raw host: ask execHostOf/cliHostOf, or list the file with why\n${where.filter((w) => !(w.split(':')[0]! in RAW_PLACE_ALLOWED)).join('\n')}`).toEqual(want)
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

    it('a read of its files goes by the row\'s own name, which a host\'s link maps to its follower link (readHostOf)', () => {
      role.replica = true
      process.env.WALNUT_HOST_KEY = 'devbox'
      expect(readHostOf({ judge: 'host', host: 'devbox' } as never)).toBe('devbox')
      for (const host of [undefined, '', '__local__']) expect(readHostOf({ host })).toBeUndefined()
      expect(readHostOf(null)).toBeUndefined()
    })
  })

  it('a reader through hosts/link.ts is never given cliHostOf: link.ts refuses \'__local__\' on a host replica', () => {
    const hits: string[] = []
    for (const file of srcFiles('src')) {
      codeLines(fs.readFileSync(path.join(ROOT, file), 'utf8')).forEach((line, i) => {
        if (/\b(?:DaemonFileReader|link|statStreamFile|readSessionJsonlContent|invalidateSessionHistoryCaches)\(\s*(?:[\w.]+,\s*)*(?:cliHostOf|execHostOf)\(/.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(hits).toEqual([])
  })
})
