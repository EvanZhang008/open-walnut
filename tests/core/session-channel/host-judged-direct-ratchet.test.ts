/**
 * Ratchet for the one rule of src/core/session-channel/host-judged-direct.ts: every companion
 * path that writes into a host's daemon directly (a bridge `send`, `sendRaw`, `session.permission`,
 * `bridgeResume`, `appendUserMarker`, or a lead's `leader.control` / `leader.deliver` /
 * `leader.settings`) asks `directToDaemonAllowed` before its first byte, so a session its host
 * judges is never written into its CLI behind that host.
 *
 * Enumerated from the source: a file that issues one of those commands and is not listed here
 * fails, and a listed file whose call sites or checks change fails until the list says why. A new
 * direct path is added here only with its check.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')
const DIRS = ['src/core', 'src/web', 'src/lib', 'src/integrations', 'src/replica']
/** A request whose command (its second argument) writes into the daemon, or a lead's call (its third). */
const DIRECT_CMD = /\b(?:bridgeRequest|bridgeRequestPrepared|request)\(\s*[^,();]+,\s*'(send|sendRaw|session\.permission|bridgeResume|appendUserMarker|leader\.control|leader\.deliver|leader\.settings)'|\bcallLeadHost\([^;]*?'(leader\.[a-zA-Z]+)'/g
const CHECK = /\bdirectToDaemonAllowed\(/g

/** Each direct path: how many direct call sites it has, how many checks guard them, and where. */
const DIRECT: Record<string, { sites: number; checks: number; why: string }> = {
  'src/core/sessions/direct-host-send.ts': { sites: 4, checks: 1, why: 'deliverDirectToHost checks once, before deliverOnce makes any of its calls (send, appendUserMarker, bridgeResume)' },
  'src/web/routes/bridge-send.ts': { sites: 2, checks: 2, why: 'the Mac\'s send and session.permission through the companion, each checked after its host is resolved' },
  'src/core/leader/host-session-control.ts': { sites: 1, checks: 1, why: 'target() checks, and every leader.control (Stop, a prompt\'s answer, a mode) goes through a target' },
  'src/core/sessions/model-options-copy.ts': { sites: 1, checks: 1, why: 'applyOnHost checks before leader.settings' },
  'src/core/leader/backup-gateway.ts': { sites: 1, checks: 1, why: 'deliver() checks the target session before leader.deliver' },
}
/** Files that issue such a command to something that is not a daemon. */
const NOT_DIRECT: Record<string, string> = {
  'src/core/session-channel/leader-side.ts': 'the leader\'s calls to the host\'s own /host-api routes: the host\'s judge itself takes them',
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

/** Code without comments, so a comment naming a command is no call site. */
function code(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const found = new Map<string, { sites: number[]; checks: number[] }>()
for (const file of DIRS.flatMap(walk)) {
  const text = code(file)
  const sites = [...text.matchAll(DIRECT_CMD)].map((m) => m.index ?? 0)
  if (sites.length === 0) continue
  found.set(file, { sites, checks: [...text.matchAll(CHECK)].map((m) => m.index ?? 0) })
}

describe('every companion path straight into a host\'s daemon asks the one rule first', () => {
  it('every file with a direct daemon command is listed', () => {
    expect([...found.keys()].filter((f) => !DIRECT[f] && !NOT_DIRECT[f]).sort(), 'a new direct path: ask directToDaemonAllowed before its first byte and list it in DIRECT').toEqual([])
    expect(Object.keys(DIRECT).filter((f) => !found.has(f)), 'listed but gone: remove it from DIRECT').toEqual([])
  })

  it('each listed path keeps its call sites and its checks, a check before its first call', () => {
    for (const [file, want] of Object.entries(DIRECT)) {
      const got = found.get(file)!
      expect({ sites: got.sites.length, checks: got.checks.length }, `${file}: ${want.why}`).toEqual({ sites: want.sites, checks: want.checks })
      expect(Math.min(...got.checks), `${file}: the check comes before the first direct call`).toBeLessThan(Math.min(...got.sites))
    }
  })

  it('each check in bridge-send.ts guards its own route: one check before each direct call', () => {
    const { sites, checks } = found.get('src/web/routes/bridge-send.ts')!
    sites.forEach((at, i) => {
      const from = i === 0 ? 0 : sites[i - 1]!
      expect(checks.some((c) => c > from && c < at), `direct call ${i + 1} of bridge-send.ts`).toBe(true)
    })
  })

  it('the banked-send sweep asks the rule before it asks the Mac to give a row back', () => {
    const text = code('src/core/send-queue-sweep.ts')
    const check = text.search(CHECK)
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(text.indexOf('directDeliveryGate(op'))
  })

  it('every caller of the direct send funnel goes through it, not around it', () => {
    const callers = DIRS.flatMap(walk).filter((f) => f !== 'src/core/sessions/direct-host-send.ts' && /\bdeliverDirectToHost\(/.test(code(f))).sort()
    expect(callers).toEqual(['src/core/send-queue-sweep.ts', 'src/web/routes/cloud-send-direct.ts', 'src/web/routes/human-inbox-takeover.ts'])
  })
})
