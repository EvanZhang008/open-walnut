/**
 * No daemon command a client sends shows a person the daemon swap (daemon-drain-resend.ts).
 *
 * 2026-11-10: a deploy replaced the Mac's daemon, and in the 2.6 s the old one drained it
 * refused triggers.configure, net.identity, host.slice, leader.configure, upload.part,
 * usage.budget.get, fs.read and replica.sync with "Daemon is shutting down; retry after
 * reconnecting". The upload's refusal reached the composer as "Not uploaded" with a Retry button.
 *
 * Pinned, from the source so a new member fails here:
 *  - a drain refusal means the command ran not at all: only the drain's own check says those
 *    words, and every place a twin hands work to the drain does it before any await;
 *  - every command either daemon twin handles is sent again after a drain refusal, unless it is
 *    exempt with a reason, and the loop answers the next daemon's reply for it;
 *  - every command listed as safe to send again after a lost reply is one the daemon handles;
 *  - every file that writes a command frame to a daemon is listed: it goes through the resend
 *    loop, or says why its refusal is the answer it wants.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DRAIN_RESEND_EXEMPT, RESEND_AFTER_LOST, isDaemonDrainRefusal, resendThroughSwap, resendsAfter, wakeHostLink, waitHostLink,
} from '../../src/providers/daemon-drain-resend.js'
import { createDaemonCommandDrain } from '../../src/providers/daemon-command-drain.js'

const REPO = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8')

/** The case labels of `function dispatchCommand(` up to the function's closing brace at column 0. */
function dispatched(rel: string): string[] {
  const src = read(rel)
  const start = src.search(/^function dispatchCommand\(/m)
  expect(start, `${rel} has no dispatchCommand`).toBeGreaterThan(0)
  const end = src.indexOf('\n}\n', start)
  return [...src.slice(start, end).matchAll(/case '([^']+)'/g)].map((m) => m[1])
}

const COMMANDS = [...new Set([...dispatched('src/providers/daemon-standalone.ts'), ...dispatched('src/providers/daemon-source.ts')])].sort()
const TWINS = ['src/providers/daemon-standalone.ts', 'src/providers/daemon-source.ts']

/** Places a twin hands work to the drain after an await, each with why that is no client's command. */
const RUN_AFTER_AWAIT: Record<string, string> = {
  fireTurnRetry: "the daemon's own retry timer: it checks the drain is open first and answers no client",
}

describe('a drain refusal means the command ran not at all', () => {
  it('the drain refuses in the words the loop reads, and nothing else says them', async () => {
    const drain = createDaemonCommandDrain()
    await drain.close()
    let said = ''
    try { drain.admit(() => 'ran') } catch (err) { said = (err as Error).message }
    expect(isDaemonDrainRefusal({ ok: false, error: `internal daemon error handling fs.read: ${said}` })).toBe(true)
    const sayers = sources('src').filter((rel) => read(rel).includes('Daemon is shutting down; retry after reconnecting'))
    expect(sayers.sort()).toEqual(['src/providers/daemon-command-drain.ts', 'src/providers/daemon-drain-resend.ts'])
  })

  it.each(TWINS)('%s: work reaches the drain before any await, so a refusal comes before any of it ran', (rel) => {
    const src = read(rel)
    const starts = [...src.matchAll(/^(?:async\s+)?function\s+(\w+)\s*\(/gm)].map((m) => ({ name: m[1], at: m.index! }))
    const late: string[] = []
    starts.forEach((fn, i) => {
      const body = src.slice(fn.at, starts[i + 1]?.at ?? src.length)
      if (!body.includes('daemonCommands.run(')) return
      // dispatchCommand: each case on its own.
      const pieces = fn.name === 'dispatchCommand' ? body.split(/\n\s*case '/) : [body]
      for (const piece of pieces) {
        const at = piece.indexOf('daemonCommands.run(')
        if (at >= 0 && /\bawait\b/.test(piece.slice(0, at)) && !RUN_AFTER_AWAIT[fn.name]) late.push(`${fn.name}: ${piece.slice(0, 50)}`)
      }
    })
    expect(late, 'hand the work to the drain before the first await, or list why it is no client command').toEqual([])
    expect(src).toMatch(/daemonCommands\.admit\(work\)/)
  })
})

describe('every daemon command goes on through a swap', () => {
  it('the twins handle a sane number of commands (the parse found the switch)', () => {
    expect(COMMANDS.length).toBeGreaterThan(150)
    expect(COMMANDS).toContain('upload.part')
  })

  it('each exemption names a command the daemon handles and says why', () => {
    for (const [cmd, why] of Object.entries(DRAIN_RESEND_EXEMPT)) {
      expect(COMMANDS, `exempt ${cmd} is no daemon command`).toContain(cmd)
      expect(why.length, `exempt ${cmd} needs a reason`).toBeGreaterThan(20)
    }
  })

  it('each command sent again after a lost reply is one the daemon handles, with why', () => {
    for (const [cmd, why] of Object.entries(RESEND_AFTER_LOST)) {
      expect(COMMANDS, `${cmd} is no daemon command`).toContain(cmd)
      expect(why.length).toBeGreaterThan(3)
      expect(Object.hasOwn(DRAIN_RESEND_EXEMPT, cmd), `${cmd} is both exempt and resent`).toBe(false)
    }
  })

  it.each(COMMANDS.filter((cmd) => !Object.hasOwn(DRAIN_RESEND_EXEMPT, cmd)))('%s: a drain refusal is never the answer', async (cmd) => {
    expect(resendsAfter(cmd, 'refused')).toBe(true)
    const key = `guard:${cmd}`
    const replies = [
      { ok: false, error: `internal daemon error handling ${cmd}: Daemon is shutting down; retry after reconnecting` },
      { ok: true, from: 'the new daemon' },
    ]
    let tries = 0
    const pending = resendThroughSwap(cmd, {
      once: async () => replies[tries++],
      failure: () => null,
      swapUnderway: () => true,
      noteRefusal: () => { setTimeout(() => wakeHostLink(key), 0) },
      waitLink: (ms) => waitHostLink(key, ms, () => false),
    }, 30_000)
    expect(await pending).toEqual({ ok: true, from: 'the new daemon' })
    expect(tries).toBe(2)
  })
})

// Every file that writes a command frame to a daemon, how a drain refusal reaches its caller, and
// how many frame writes it holds: a new one in a listed file fails here too, until it is looked at.
type Client = { frames: number } & ({ resends: string } | { exempt: string })
const CLIENTS: Record<string, Client> = {
  'src/providers/daemon-connection.ts': { frames: 4, resends: 'send() is the loop over sendOnce (the payload); the other three are the dial (hello, the capability handshake, the probe role), before the link serves a command' },
  'src/web/ws/bridge-registry.ts': { frames: 2, resends: 'bridgeRequest and bridgeRequestPrepared both go through throughSwap' },
  'src/host-server/daemon-link.ts': { frames: 1, resends: 'request() goes through the loop; the dial and status poll use the same call(), before any request' },
  'src/commands/net.ts': { frames: 1, resends: 'daemonRpc is the loop over daemonRpcOnce' },
  'src/providers/local-daemon.ts': { frames: 3, exempt: 'its probes of the daemon on one port (hello, exec.list, the login-session check): they ask that daemon itself, and the next probe or ensureRunning asks the next one' },
  'src/providers/daemon-service-cli.ts': { frames: 1, exempt: 'the service check after a swap says hello to learn which daemon serves; a draining one is the answer it looks for' },
  'src/providers/stream-lane.ts': { frames: 1, exempt: 'the lane dial (hello, stream.lane): a refusal drops the lane and its own redial reaches the next daemon' },
}

// A command frame: an object with an `id` key right before `cmd` (or a spread frame), the same
// stringified with `cmd` first, or the prepared send's template. Comments are taken out first.
const FRAME_G = /\{(?:[^{}]*?,)?\s*id\b(?:\s*:\s*[\w.]+)?\s*,\s*(?:cmd\b|\.\.\.frame\b)[^{}]*\}|JSON\.stringify\(\{[^{}]*\bcmd\b[^{}]*\bid\b|\{"id":\$\{[^}]+\},"cmd"/g
const FRAME = new RegExp(FRAME_G.source)
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
const DAEMON_SIDE = new Set(['src/providers/daemon-standalone.ts', 'src/providers/daemon-source.ts'])

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name)
    if (entry.isDirectory()) sources(rel, out)
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(entry.name)) out.push(rel)
  }
  return out
}

describe('every client of a daemon is listed', () => {
  const found = sources('src').filter((rel) => !DAEMON_SIDE.has(rel) && FRAME.test(code(rel))).sort()

  it('the scan finds the known clients', () => {
    expect(found).toContain('src/providers/daemon-connection.ts')
    expect(found).toContain('src/web/ws/bridge-registry.ts')
  })

  it.each(found)('%s says how a drain refusal reaches its caller', (rel) => {
    const entry = CLIENTS[rel]
    expect(entry, `${rel} writes daemon command frames: send them through resendThroughSwap (daemon-drain-resend.ts) or list why its refusal is the answer`).toBeDefined()
    if ('resends' in entry) expect(read(rel)).toMatch(/resendThroughSwap\(/)
    expect(('resends' in entry ? entry.resends : entry.exempt).length).toBeGreaterThan(20)
    expect(code(rel).match(FRAME_G)?.length ?? 0, `${rel}: a frame write was added or removed; say how a drain refusal reaches its caller, then update the count`).toBe(entry.frames)
  })

  it('no listed client is gone', () => {
    for (const rel of Object.keys(CLIENTS)) expect(found, `${rel} is listed but writes no frame now`).toContain(rel)
  })
})
