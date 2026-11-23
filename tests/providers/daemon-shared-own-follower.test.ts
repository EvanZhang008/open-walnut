/**
 * A leader reads its own host replica's data dir in a daemon's record as itself, at every place
 * a server decides whether to keep another build's daemon (daemon-shared.ts
 * thisWalnutSharedVerdict).
 *
 * 2026-11-23: a daemon before that day filed a host replica's own data dir (its OPEN_WALNUT_HOME)
 * as a second Walnut, and the replica refreshes that key on every push, so the record keeps it
 * for as long as that daemon runs. The daemon fix (served-walnuts-core.ts) cannot reach a host
 * while its leader keeps the old daemon for "another Walnut uses it": without the leader's side,
 * every such host waited one more overdue round (about four hours) on the release that fixed it.
 *
 * Pinned:
 *   - each caller, run for real on a record holding only this Walnut's key and its own follower's
 *     data dir key, does not keep the daemon; with a real other Walnut's key besides, it does;
 *   - the follower key is per host: the shared dir from before the split counts only on the host
 *     whose record names it, a dir named by this Walnut's id on any host for this computer's daemon;
 *   - `sharedDaemonVerdict` is called in src only by thisWalnutSharedVerdict, and every caller of
 *     that is listed in CALLERS (with a case run above), so a new caller cannot skip the follower key.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-own-follower'))

import { WALNUT_HOME } from '../../src/constants.js'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { LocalDaemon } from '../../src/providers/local-daemon.js'
import { sharedWhy } from '../../src/providers/daemon-net-update.js'
import { ourDaemonCapabilities, walnutKeyOf, type DaemonServes } from '../../src/providers/daemon-shared.js'
import { ownFollowerDirsIn, HOST_SERVERS_FILE } from '../../src/core/host-server/own-follower-dirs.js'
import { log } from '../../src/logging/index.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const RUNNING = 'walnut-daemon-running00001'
const EXPECTED = 'walnut-daemon-expected0002'
const HOST = 'devbox'
const OTHER_HOST = 'otherbox'
/** This Walnut's server on HOST, in the layout named by its id (install.ts walnutDirs). */
const FOLLOWER = '/home/tester/.walnut-host/walnuts/0123456789abcdef/data'
/** The shared dir from before the split, this Walnut's on OTHER_HOST only. */
const LEGACY = '/home/tester/.walnut-host/data'
const STRANGER = 'cccccccccccccccc'

const working = (dir: string) => ({ id: 'b1', command: '/x/walnut', args: ['web', '--replica'], env: { OPEN_WALNUT_HOME: dir }, cwd: dir, log: `${dir}/../logs/server.log` })
const STATE = { [HOST]: { publicPort: 41_000, working: working(FOLLOWER) }, [OTHER_HOST]: { publicPort: 41_001, working: working(LEGACY) } }

/** A daemon of another build with every capability this build's has, used lately by the given dirs' Walnuts. */
function record(...homes: string[]): DaemonServes {
  const now = Date.now() - 60_000
  const walnuts: Record<string, number> = { [walnutKeyOf(WALNUT_HOME)]: now }
  for (const h of homes) walnuts[h === STRANGER ? STRANGER : walnutKeyOf(h)] = now
  return { version: RUNNING, twin: 'binary', capabilities: ourDaemonCapabilities('binary'), walnuts, pty: true }
}

/**
 * Every caller of thisWalnutSharedVerdict in src, and how that caller decides on a record for
 * the host it runs for: true = it keeps the running daemon.
 */
const CALLERS: Record<string, { host: string | null; keeps: (rec: DaemonServes, host: string | null) => Promise<boolean> }> = {
  'src/providers/daemon-connection.ts': {
    host: HOST,
    keeps: (rec, host) => (new DaemonConnection(host!, { hostname: `${host}.example.com`, user: 'tester' }) as unknown as {
      keepSharedDaemon: (r: DaemonServes, v: string, e: string) => Promise<boolean>
    }).keepSharedDaemon(rec, RUNNING, EXPECTED),
  },
  'src/providers/daemon-net-update.ts': {
    host: HOST,
    keeps: async (rec, host) => (await sharedWhy({ host: host!, daemonVersion: RUNNING, daemonServes: rec }, EXPECTED, Date.now())) !== null,
  },
  'src/providers/local-daemon.ts': {
    host: null,
    keeps: (rec) => (new LocalDaemon({ daemonDir: path.join(WALNUT_HOME, 'local-daemon') }) as unknown as {
      keepSharedDaemon: (h: { version: string; served: DaemonServes }, e: string) => Promise<boolean>
    }).keepSharedDaemon({ version: RUNNING, served: rec }, EXPECTED),
  },
}

const stateFile = path.join(WALNUT_HOME, HOST_SERVERS_FILE)
beforeAll(() => {
  vi.spyOn(log.session, 'info').mockImplementation(() => {})
  fs.mkdirSync(WALNUT_HOME, { recursive: true })
  fs.writeFileSync(stateFile, JSON.stringify(STATE))
})
afterAll(() => {
  vi.restoreAllMocks()
  fs.rmSync(stateFile, { force: true })
})

describe('a leader reads its own host replica in a daemon\'s record as itself', () => {
  for (const [file, c] of Object.entries(CALLERS)) {
    it(`${file}: only this Walnut and its own follower is not shared; a real other Walnut still is`, async () => {
      expect(await c.keeps(record(FOLLOWER), c.host), 'its own follower is not another Walnut').toBe(false)
      expect(await c.keeps(record(FOLLOWER, STRANGER), c.host), 'another Walnut still keeps it').toBe(true)
    })
  }

  it('the shared dir from before the split is this Walnut\'s only on the host whose record names it', async () => {
    const net = CALLERS['src/providers/daemon-net-update.ts']!
    expect(await net.keeps(record(LEGACY), OTHER_HOST)).toBe(false)
    expect(await net.keeps(record(LEGACY), HOST)).toBe(true)
    // This computer's own daemon (no host named): only a dir named by this Walnut's id.
    expect(await CALLERS['src/providers/local-daemon.ts']!.keeps(record(LEGACY), null)).toBe(true)
    expect(ownFollowerDirsIn(STATE, null)).toEqual([FOLLOWER])
    expect(ownFollowerDirsIn(STATE, OTHER_HOST)).toEqual([LEGACY])
    expect(ownFollowerDirsIn(STATE, 'nohost')).toEqual([])
    expect(ownFollowerDirsIn({ [HOST]: { publicPort: 1 } }, HOST)).toEqual([])
  })
})

/** The files in src that call `name(...)`, with how often. */
function callSites(name: string): Record<string, number> {
  const out: Record<string, number> = {}
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) { walk(p); continue }
      if (!/\.(ts|tsx)$/.test(ent.name) || ent.name.endsWith('.d.ts')) continue
      const text = fs.readFileSync(p, 'utf8')
      if (!text.includes(name)) continue
      const sf = ts.createSourceFile(p, text, ts.ScriptTarget.ES2022, true)
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
          const rel = path.relative(ROOT, p)
          out[rel] = (out[rel] ?? 0) + 1
        }
        ts.forEachChild(n, visit)
      }
      visit(sf)
    }
  }
  walk(path.join(ROOT, 'src'))
  return out
}

describe('every way to the verdict counts this Walnut\'s own followers', () => {
  it('sharedDaemonVerdict is called in src only by thisWalnutSharedVerdict', () => {
    expect(callSites('sharedDaemonVerdict')).toEqual({ 'src/providers/daemon-shared.ts': 2 })
    const shared = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-shared.ts'), 'utf8')
    const body = shared.slice(shared.indexOf('export async function thisWalnutSharedVerdict'))
    expect(body.match(/sharedDaemonVerdict\(/g)?.length).toBe(2)
    expect(body).toMatch(/ownFollowerKeys: dirs\.map\(walnutKeyOf\)/)
  })

  it('every caller of thisWalnutSharedVerdict is listed in CALLERS, with its case run above', () => {
    const sites = callSites('thisWalnutSharedVerdict')
    expect(Object.keys(sites).sort(), 'a new caller: add it to CALLERS with a case that runs it').toEqual(Object.keys(CALLERS).sort())
    for (const n of Object.values(sites)) expect(n).toBe(1)
  })
})
