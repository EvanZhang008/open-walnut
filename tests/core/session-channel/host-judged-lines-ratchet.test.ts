/**
 * Ratchet for the one rule of src/core/session-channel/host-judged-lines.ts: every host path that
 * writes a line into a session's CLI through the daemon, instead of through the session's runner,
 * asks `attachJudgeFirst` before its first byte, so a session this host judges is never answered
 * by a CLI no runner reads (2026-11-23: a same-host send after a restart of the host's service).
 *
 * Enumerated from the source: a file that issues one of the daemon's write commands into a session
 * (`follower.peer`, `follower.send`, `follower.permission`, `follower.trigger.deliver`) and is not
 * listed here fails, and a listed file whose call sites or checks change fails until the list says
 * why. The daemon's own writers (its away answer, its same-host delivery while no follower takes
 * it) cannot reach the runner: the runner's attach at boot and its replay from the last judged turn
 * end cover them, checked at the end.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')
const DIRS = ['src/core', 'src/web', 'src/lib', 'src/integrations', 'src/replica', 'src/host-server']
/** A call whose command writes into a session's CLI through the daemon. */
const WRITE_CMD = /\b(?:call|request)\(\s*'(follower\.(?:peer|send|permission|trigger\.deliver))'/g
const CHECK = /\battachJudgeFirst\(/g

/** Each path: its write call sites, the checks that guard them, and why. */
const WRITERS: Record<string, { sites: number; checks: number; why: string }> = {
  'src/replica/away-sends.ts': { sites: 2, checks: 1, why: 'the same-host send checks its target before follower.peer kind send; the other site is kind hold, which only keeps the message for the Mac' },
  'src/replica/away-replies.ts': { sites: 1, checks: 1, why: 'the reply checks the asking session before follower.peer kind reply' },
  'src/replica/write-port.ts': { sites: 2, checks: 2, why: 'send and permission each check their session first; every away send (a plain note, a plugin job, a console send, a task message) goes through send' },
  'src/replica/away-trigger-delivery.ts': { sites: 1, checks: 2, why: 'a fire delivered to a session checks it before follower.trigger.deliver, and again after it, when the daemon resumed the session itself' },
  'src/host-server/alone-api.ts': { sites: 2, checks: 2, why: 'a message and a prompt\'s answer while the host is alone each check their session first' },
}
/** Files whose matching calls are not writes into a CLI. */
const NOT_WRITES: Record<string, string> = {}

function walk(dir: string): string[] {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return []
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) return walk(rel)
    return /\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [rel] : []
  })
}

/** Code without comments, so a comment naming a command is no call site. */
function code(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const found = new Map<string, { sites: number[]; checks: number[] }>()
for (const file of DIRS.flatMap(walk)) {
  const text = code(file)
  const sites = [...text.matchAll(WRITE_CMD)].map((m) => m.index ?? 0)
  if (sites.length === 0) continue
  found.set(file, { sites, checks: [...text.matchAll(CHECK)].map((m) => m.index ?? 0) })
}

describe('every host path that writes into a session\'s CLI past its runner lets the runner attach first', () => {
  it('every file with such a write is listed', () => {
    expect([...found.keys()].filter((f) => !WRITERS[f] && !NOT_WRITES[f]).sort(), 'a new writer: call attachJudgeFirst before its first byte and list it in WRITERS').toEqual([])
    expect(Object.keys(WRITERS).filter((f) => !found.has(f)), 'listed but gone: remove it from WRITERS').toEqual([])
  })

  it('each listed path keeps its call sites and its checks', () => {
    for (const [file, want] of Object.entries(WRITERS)) {
      const got = found.get(file)!
      expect({ sites: got.sites.length, checks: got.checks.length }, `${file}: ${want.why}`).toEqual({ sites: want.sites, checks: want.checks })
    }
  })

  it('in each file but away-sends, every write has a check before it, after the write before it', () => {
    for (const file of Object.keys(WRITERS).filter((f) => f !== 'src/replica/away-sends.ts')) {
      const { sites, checks } = found.get(file)!
      sites.forEach((at, i) => {
        const from = i === 0 ? 0 : sites[i - 1]!
        expect(checks.some((c) => c > from && c < at), `${file}: write ${i + 1}`).toBe(true)
      })
    }
  })

  it('the same-host send checks its target between the hold and the send', () => {
    const { sites, checks } = found.get('src/replica/away-sends.ts')!
    const text = code('src/replica/away-sends.ts')
    const send = sites.find((at) => !/kind: 'hold'/.test(text.slice(at, at + 80)))!
    expect(send, 'the send site').toBeDefined()
    expect(checks.some((c) => c < send && c > Math.min(...sites)), 'a check before the send, after the hold').toBe(true)
    expect(text.slice(checks[0]!, checks[0]! + 60)).toContain('target.sid')
  })

  it('the daemon\'s own writers are covered: the host attaches its own rows at boot and replays from the last judged turn end', () => {
    const boot = code('src/core/session-channel/host-boot.ts')
    expect(boot, 'the host puts the rule in place with its session side').toMatch(/installOwnAttach\(/)
    expect(boot, 'and takes it away when it stops').toMatch(/c\.ownAttach\(\)/)
    const rule = code('src/core/session-channel/host-judged-lines.ts')
    expect(rule, 'the attach before a write').toMatch(/setJudgeAttach\(async/)
    expect(rule, 'cleared at the stop').toMatch(/setJudgeAttach\(null\)/)
    expect(rule, 'the boot attach of the own rows, once the runner is up').toMatch(/runnerReady[\s\S]*startOwnAttach\(/)
    const session = code('src/providers/claude-code-session.ts')
    expect(session, 'an attach of an own row replays from its judged position').toMatch(/judgedReplayFloor\(/)
  })
})
