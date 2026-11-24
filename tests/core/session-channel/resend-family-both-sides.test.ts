/**
 * The resend family is one list for both judges (docs/plan/one-service-every-host.md, phase 2): what
 * resends into a session, respawns it or tries its lines again runs where the session is judged. The
 * leader starts each member for the sessions it judges itself (its own machine's, and an ssh host's
 * that does not run its sessions: web/server.ts); a host that runs its sessions starts the same
 * member for its own (session-channel/host-resend.ts). The leader's own machine's sessions and a
 * host's own sessions so get the same members, and a member added on one side only fails here.
 *
 * 2026-11-24: delivery-retry (a parked row tried again by itself, 2026-11-23) had been added on the
 * leader only, so a parked row in a host-judged session's queue, which lives on its host, was never
 * tried again.
 *
 * And every module that asks judge-of.ts whether this server judges a session (judgedHere,
 * judgedHereOnly, judgedHereRecords: the mark of a judge's job) is a member here or says why it is not.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const SERVER = 'src/web/server.ts'
const HOST = 'src/core/session-channel/host-resend.ts'

/** Each member: its module (repo path, no extension) and the start both sides call. */
const FAMILY: Record<string, string> = {
  'src/core/sessions/turn-run': 'startTurnRun',
  'src/core/sessions/queue-after-turn': 'startQueueAfterTurn',
  'src/core/sessions/cold-hold': 'startColdHold',
  'src/core/sessions/delivery-retry': 'startDeliveryRetry',
  'src/core/sessions/idle-compaction': 'startIdleCompaction',
  'src/core/sessions/prompt-refresh-respawn': 'startPromptRefreshRespawn',
  'src/core/sessions/context-full-recovery': 'startContextFullRecovery',
  'src/core/sessions/safeguard-switch': 'startSafeguardSwitch',
  'src/core/sessions/model-restore': 'startModelRestore',
  'src/core/session-auto-continue': 'startSessionAutoContinue',
  'src/core/sessions/endpoint-wait': 'startEndpointWait',
  'src/core/sessions/usage-limit-wait': 'startUsageLimitWait',
}

/** Modules that ask judgedHere* and are not members: why each is right as it is. */
const NOT_MEMBERS: Record<string, string> = {
  'src/core/sessions/judge-of': 'the predicate itself',
  'src/core/session-channel/host-judged-lines': 'the host\'s own attach before a line into its CLI: host side only by what it is',
  'src/core/sessions/session-stop': 'the stop coordinator\'s pending stops, read where the stop is carried out: a host carries out its own sessions\' stops (sessions/session-lifecycle.ts terminateSession)',
  'src/core/sessions/held-notices-sweep': 'a read inside the quiet-turn check, not a job of its own',
  'src/core/session-health-monitor': 'the leader\'s monitor (boot policy: no replica runs it); a host repairs its own rows\' dead processes with session-channel/host-stale-repair.ts',
  'src/core/sessions/auto-recover-env': 'restart recovery\'s inputs (boot policy: leader only); a host takes its own sessions again after a restart of its service by the boot attach and the told-line replay (host-judged-lines.ts)',
  'src/providers/daemon-connection': 'the reconnect rescue pass of the leader\'s daemon links',
  'src/core/session-tracker': 'the session command gate\'s filters (stale-row repair, capacity eviction, the orphan sweep): a host-judged row is its host\'s to repair, evict or sweep, so these leave it out; no job of the resend family',
  'src/providers/service-set-move-checks': 'a service set move\'s list of sessions to move: a host-judged one is its host service\'s already; no job of the resend family',
  'src/core/sessions/task-complete-stop': 'a completed task\'s turn-end stops read back at startup on each side (the leader\'s boot migration, host-boot.ts on a host): each side resumes only the rows it judges; no job of the resend family',
}

function code(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l)).join('\n')
}

/** Does `file` import `mod` (dynamically or statically) and call `start`? */
function starts(file: string, mod: string, start: string): boolean {
  const src = code(file)
  const rel = path.posix.relative(path.posix.dirname(file), mod)
  const spec = (rel.startsWith('.') ? rel : `./${rel}`) + '.js'
  return src.includes(`'${spec}'`) && new RegExp(`\\b${start}\\(`).test(src)
}

function walk(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.posix.join(dir, e.name)
    if (e.isDirectory()) return walk(rel)
    return e.name.endsWith('.ts') ? [rel] : []
  })
}

describe('the resend family is one list on the leader and on a host', () => {
  it('the leader starts every member', () => {
    const missing = Object.entries(FAMILY).filter(([mod, start]) => !starts(SERVER, mod, start)).map(([mod, start]) => `${mod} ${start}`)
    expect(missing).toEqual([])
  })

  it('a host that runs its sessions starts every member too', () => {
    const missing = Object.entries(FAMILY).filter(([mod, start]) => !starts(HOST, mod, start)).map(([mod, start]) => `${mod} ${start}`)
    expect(missing, `a member the leader runs for its own sessions that a host does not run for its own: start it in ${HOST}`).toEqual([])
  })

  it('every module that asks whether this server judges a session is a member or says why not', () => {
    const askers = walk('src')
      .filter((f) => /\bjudgedHere(?:Only|Records)?\(/.test(code(f)))
      .map((f) => f.replace(/\.ts$/, ''))
      .sort()
    const unlisted = askers.filter((m) => !(m in FAMILY) && !(m in NOT_MEMBERS))
    expect(unlisted, 'a new judge\'s job: add it to FAMILY (and start it on both sides) or to NOT_MEMBERS with why').toEqual([])
    // A listed module that no longer asks is taken off the list.
    expect(Object.keys(NOT_MEMBERS).filter((m) => !askers.includes(m))).toEqual([])
  })
})
