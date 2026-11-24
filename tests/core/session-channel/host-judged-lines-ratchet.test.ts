/**
 * Ratchet for the one rule of src/core/session-channel/host-judged-lines.ts: every host path that
 * writes a line into a session's CLI through the daemon, instead of through the session's runner,
 * asks `attachJudgeFirst` before its first byte, so a session this host judges is never answered
 * by a CLI no runner reads (2026-11-23: a same-host send after a restart of the host's service).
 *
 * The commands come from the daemon itself: every command a follower (the host's own server) may
 * send it (daemon-standalone.ts FOLLOWER_ALLOWED_COMMANDS) is classified here as writing into a CLI
 * or not, so a new one fails until it is. A file that names a writing command anywhere in its code
 * (a call, a constant, a table) and is not listed fails, and a listed file whose sites or checks
 * change fails until the list says why.
 *
 * The daemon's own writers (its away answer to a session's `walnut` call, its same-host delivery
 * while no follower takes it, a trigger resume it makes alone) never pass the host's server: the
 * last case here runs what covers them, the boot attach by the runtime's registry and the replay
 * from the told line (end to end: tests/providers/attach-judged-replay.test.ts).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { startOwnAttach } from '../../../src/core/session-channel/host-judged-lines.js'
import { judgedReplayFloor, type StreamEvidence } from '../../../src/providers/attach-evidence.js'

const ROOT = path.resolve(__dirname, '../../..')
const DIRS = ['src/core', 'src/web', 'src/lib', 'src/integrations', 'src/replica', 'src/host-server']

/** Every follower command of the daemon: does it write a line into a session's CLI? */
const FOLLOWER_COMMANDS: Record<string, { writes: boolean; why: string }> = {
  'hello': { writes: false, why: 'the link\'s handshake' },
  'ping': { writes: false, why: 'a liveness ping' },
  'follower.hello': { writes: false, why: 'the follower\'s handshake' },
  'follower.status': { writes: false, why: 'who leads' },
  'follower.report': { writes: false, why: 'the server\'s status report' },
  'server.status': { writes: false, why: 'a read' },
  'list': { writes: false, why: 'a read of the sessions' },
  'status': { writes: false, why: 'a read of one session' },
  'attach': { writes: false, why: 'a subscription to a session\'s stream' },
  'read-history': { writes: false, why: 'a read' },
  'markers.find': { writes: false, why: 'a read' },
  'follower.sessions': { writes: false, why: 'a read of this Walnut\'s sessions here' },
  'follower.send': { writes: true, why: 'a plain note into a running session' },
  'follower.permission': { writes: true, why: 'the answer to a prompt: the turn goes on' },
  'follower.op': { writes: false, why: 'a journaled write of the Walnut\'s data, never a CLI line' },
  'follower.pending': { writes: false, why: 'a read of the journal' },
  'follower.triggers': { writes: false, why: 'a read of the triggers' },
  'follower.trigger.test': { writes: false, why: 'runs a trigger\'s check script, never a CLI line' },
  'follower.gateway': { writes: false, why: 'a session\'s walnut call: what the daemon answers itself is its own writer (the last case)' },
  'follower.peer': { writes: true, why: 'a message (kind send or reply) the server decided; kind hold only keeps it for the Mac' },
  'follower.start': { writes: false, why: 'starts a new session (an ask), never a line into a running one' },
  'gateway-result': { writes: false, why: 'the answer to a relayed call' },
  'follower.trigger.deliver': { writes: true, why: 'a trigger fire into a session (or a resume of it)' },
  'stream.open': { writes: false, why: 'a stream frame' },
  'stream.accept': { writes: false, why: 'a stream frame' },
  'stream.data': { writes: false, why: 'a stream frame' },
  'stream.ack': { writes: false, why: 'a stream frame' },
  'stream.end': { writes: false, why: 'a stream frame' },
  'stream.close': { writes: false, why: 'a stream frame' },
}
const WRITES = Object.entries(FOLLOWER_COMMANDS).filter(([, c]) => c.writes).map(([cmd]) => cmd)
const WRITE_CMD = new RegExp(`['"\`](?:${WRITES.map((c) => c.replace(/\./g, '\\.')).join('|')})['"\`]`, 'g')
const CHECK = /\battachJudgeFirst\(/g

/** Each path: its write sites, the checks that guard them, and why. */
const WRITERS: Record<string, { sites: number; checks: number; why: string }> = {
  'src/replica/away-sends.ts': { sites: 2, checks: 1, why: 'the same-host send checks its target before follower.peer kind send; the other site is kind hold, which only keeps the message for the Mac' },
  'src/replica/away-replies.ts': { sites: 1, checks: 1, why: 'the reply checks the asking session before follower.peer kind reply' },
  'src/replica/write-port.ts': { sites: 2, checks: 2, why: 'send and permission each check their session first; every away send (a plain note, a plugin job, a console send, a task message) goes through send' },
  'src/replica/away-trigger-delivery.ts': { sites: 1, checks: 2, why: 'a fire delivered to a session checks it before follower.trigger.deliver, and again after it, when the daemon resumed the session itself' },
  'src/host-server/alone-api.ts': { sites: 2, checks: 2, why: 'a message and a prompt\'s answer while the host is alone each check their session first' },
}
/** Files that name a writing command without writing (each with why). */
const NOT_WRITES: Record<string, string> = {
  'src/core/link/follower-link-direct.ts': 'the in-process link\'s table of the follower commands: it carries what its callers send, who are listed above',
}

function walk(dir: string): string[] {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return []
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) return walk(rel)
    return /\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [rel] : []
  })
}

/** Code without comments, so a comment naming a command is no site. */
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
  it('every follower command the daemon takes is classified', () => {
    const daemon = code('src/providers/daemon-standalone.ts')
    const set = /const FOLLOWER_ALLOWED_COMMANDS = new Set\(\[([\s\S]*?)\]\)/.exec(daemon)
    expect(set, 'FOLLOWER_ALLOWED_COMMANDS in daemon-standalone.ts').toBeTruthy()
    const cmds = [...set![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
    expect(cmds.length).toBeGreaterThan(10)
    expect(cmds.filter((c) => !FOLLOWER_COMMANDS[c]), 'a new follower command: say whether it writes into a CLI').toEqual([])
  })

  it('every file that names a writing command is listed', () => {
    expect([...found.keys()].filter((f) => !WRITERS[f] && !NOT_WRITES[f]).sort(), 'a new writer: call attachJudgeFirst before its first byte and list it in WRITERS').toEqual([])
    expect([...Object.keys(WRITERS), ...Object.keys(NOT_WRITES)].filter((f) => !found.has(f)), 'listed but gone: remove it').toEqual([])
  })

  it('each listed path keeps its sites and its checks', () => {
    for (const [file, want] of Object.entries(WRITERS)) {
      const got = found.get(file)!
      expect({ sites: got.sites.length, checks: got.checks.length }, `${file}: ${want.why}`).toEqual({ sites: want.sites, checks: want.checks })
    }
  })

  it('every write has a check before it, after the write before it (away-sends: its send, after its hold)', () => {
    for (const file of Object.keys(WRITERS)) {
      const { sites, checks } = found.get(file)!
      const text = code(file)
      // In away-sends the hold site writes nothing (kind hold): only its send is checked.
      const writing = file === 'src/replica/away-sends.ts' ? sites.filter((at) => !/kind: 'hold'/.test(text.slice(at, at + 40))) : sites
      expect(writing.length, `${file}: its writing sites`).toBeGreaterThan(0)
      for (const at of writing) {
        const before = sites.filter((s) => s < at)
        const from = before.length ? Math.max(...before) : 0
        expect(checks.some((c) => c > from && c < at), `${file}: the write at ${at}`).toBe(true)
      }
    }
  })

  it('the daemon\'s own writes are covered: a CLI it resumed alone is attached by the runtime\'s registry, and read on from the told line', async () => {
    // The daemon resumed `alone` for a trigger fire while the service was down, and wrote its turn:
    // its row still says stopped with no pid; the runtime holds its CLI. `quiet` it does not hold.
    const attached: Array<[string, number | undefined]> = []
    const boot = startOwnAttach({
      ownRows: async () => [{ claudeSessionId: 'alone' }, { claudeSessionId: 'quiet' }],
      holds: () => false,
      liveCli: async (sid) => (sid === 'alone' ? { pid: 777 } : null),
      attach: async (sid, pid) => { attached.push([sid, pid]); return true },
      isAcp: () => false,
      passesMs: [0],
    })
    await boot.done
    expect(attached).toEqual([['alone', 777]])
    // Its attach reads on from the last line the leader was told, past which the daemon's turn sits.
    const evidence = { fileSize: 9000, fold: { lastResult: { isError: false, endOffset: 8800 } } } as unknown as StreamEvidence
    expect(judgedReplayFloor(true, -1, evidence, { v: 4000 })).toEqual({ floor: 4000, from: 'told' })
  })
})
