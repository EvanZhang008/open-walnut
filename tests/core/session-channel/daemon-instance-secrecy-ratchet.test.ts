/**
 * A daemon's instance id (its hello `instanceId`, `d-<pid>-<hex>`, new on every daemon start) never
 * leaves this server: no /api route, host profile, copy kind, session channel batch or relay answer
 * returns or carries it. Since 2026-11-24 its secrecy is a safety premise: two of the leader's own
 * daemon links that report the same live instance id are one daemon, and only that tie lets one host
 * name take the sessions of another (revoked-hosts.ts oneDaemonNow, daemon-connection.ts
 * liveSameDaemonHosts). A host that could read another daemon's id could claim to be it.
 *
 * Every mention of one in the code that answers or sends outward is listed below with what it does
 * with it; a new mention fails here until it is listed with a reason that it stays in memory.
 * Walnut's own instance id (device-store.ts getInstanceId, the server's walnutId) is another thing
 * and public on purpose: it is not matched.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '../../../src')

/** Where what this server answers or sends to a host, a phone or a browser is built (the host profile: core/hosts/host-profile.ts). */
const OUTWARD = ['web', 'core/replication', 'core/hosts', 'core/session-channel', 'core/host-server', 'core/peers', 'replica']

const TOKEN = /\b(?:daemonInstanceId|liveInstanceId|instanceId)\b/g

/** File (from src/) to the number of mentions it may hold, and why each stays in memory. */
const KEPT: Record<string, { count: number; why: string }> = {
  'web/ws/bridge-registry.ts': { count: 3, why: 'the bridge connection record in memory (its type field and the hello read into it); never listed or sent' },
  'core/hosts/fleet.ts': { count: 2, why: 'the link view field, read only as the memo key of the once-a-day host.facts probe' },
  'core/host-server/manager-types.ts': { count: 2, why: 'the link view field and its doc line' },
  'core/host-server/manager.ts': { count: 1, why: 'the memo key of the spawn template already pushed to that daemon process' },
  'core/peers/gateway-answer.ts': { count: 7, why: 'the calling daemon\'s own id on its relayed call, a dedup key only; the answer goes back to that same daemon without it' },
}

function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? files(p) : /\.tsx?$/.test(e.name) ? [p] : []
  })
}

describe('a daemon instance id stays on this server', () => {
  const found: Record<string, number> = {}
  for (const dir of OUTWARD) {
    for (const f of files(path.join(SRC, dir))) {
      const n = (fs.readFileSync(f, 'utf8').match(TOKEN) ?? []).length
      if (n > 0) found[path.relative(SRC, f).split(path.sep).join('/')] = n
    }
  }

  it('no new place that answers or sends outward mentions one', () => {
    const unlisted = Object.keys(found).filter((f) => !KEPT[f])
    expect(unlisted, `list each with why the id stays in memory, or keep it out: ${unlisted.join(', ')}`).toEqual([])
  })

  it('each listed place mentions it exactly as often as listed (a new mention is read again)', () => {
    for (const [f, { count }] of Object.entries(KEPT)) expect({ f, n: found[f] ?? 0 }).toEqual({ f, n: count })
  })
})
