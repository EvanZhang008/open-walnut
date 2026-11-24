/**
 * The dial gate (src/core/hosts/link.ts dialRefusal; drill round 4, R4-1): Walnut dials no host the
 * person removed, turned off, or that came back from ~/.ssh/config as a found host waiting for the
 * yes. Before it, a host removed in Settings that ~/.ssh/config also names came back as a found row,
 * and two seconds later a background caller dialled it again through link(): the leader was back on
 * another Walnut's shared daemon, pushing its host slice, triggers and replica there.
 *
 * Two halves:
 *  1. The ratchet: every place in src/ that can open a NEW daemon link is enumerated over the
 *     TypeScript AST (getDaemonConnection, getDirectDaemonConnection, `new DaemonConnection`), and
 *     each one must be a known site that passes the gate (or reaches only this machine). A new
 *     background dial site fails here with what to do. Pooled instances (their reconnect loop,
 *     reconnectHostNow, expediteReconnect) exist only for hosts a gated dial made, and a host that
 *     leaves Settings drops its instance (host-link-end.ts).
 *  2. The behaviour: link() refuses those hosts before any dial, a removed host found again in
 *     ~/.ssh/config included (the real merge and read rule), and a host that leaves Settings is
 *     refused at once, not after the link's target cache runs out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const state = vi.hoisted(() => ({ hosts: {} as Record<string, unknown>, dials: [] as string[], reads: 0 }))

vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: async () => { state.reads++; return { hosts: state.hosts } },
}))
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  getDaemonConnection: async (key: string) => { state.dials.push(key); return { host: key, connected: true } },
  dropDaemonConnection: () => false,
}))
vi.mock('../../../src/replica/self-host.js', () => ({ isSelfHost: () => false }))
// endHostLink's own ends (the test passes stand-ins for them).
vi.mock('../../../src/web/terminal/spawn.js', () => ({ terminalControlSocket: () => '' }))
vi.mock('../../../src/providers/ssh-control-master.js', () => ({ exitOwnedControlMaster: async () => false }))
vi.mock('../../../src/core/hosts/host-set-leave.js', () => ({ leaveHostServiceSet: async () => ({ own: false, ok: true, why: '' }) }))

import { dialRefusal, link, resetLinkTargetsForTest, UnknownHostError } from '../../../src/core/hosts/link.js'
import { endHostLink } from '../../../src/core/hosts/host-link-end.js'
import { applyFoundHostAnswers, mergeFoundHosts } from '../../../src/core/hosts/found-hosts.js'
import type { Config } from '../../../src/core/types.js'

const repoRoot = path.resolve(__dirname, '../../..')
const rel = (f: string) => path.relative(repoRoot, f).split(path.sep).join('/')

/** Every site that may open a new daemon link, and how it passes the gate. */
const DIAL_SITES: Record<string, string> = {
  'src/core/hosts/link.ts getDaemonConnection': 'the link: remoteTarget asks dialRefusal first; the local daemon and a replica\'s own host need no row',
  'src/web/local-daemon-lane.ts getDaemonConnection': 'this machine\'s own daemon only (LOCAL)',
  'src/core/hosts/host-connect-action.ts getDaemonConnection': 'a person\'s Connect now: connectHostNow asks dialRefusal first',
  'src/providers/oneshot-client.ts getDirectDaemonConnection': 'this machine\'s own daemon (\'__local__\')',
  'src/commands/demo-server.ts getDirectDaemonConnection': 'this machine\'s own daemon (\'__local__\')',
  'src/providers/local-daemon-dial.ts getDirectDaemonConnection': 'this machine\'s own daemon (\'__local__\')',
  'src/providers/acp-session.ts getDirectDaemonConnection': 'this machine\'s own daemon (\'__local__\')',
  'src/providers/remote-session-manager.ts getDirectDaemonConnection': 'a direct daemon URL (the local daemon or a test daemon), never a host row',
  'src/core/hosts/host-fixture.ts getDirectDaemonConnection': 'the Playwright host fixture\'s own daemon',
  'src/providers/daemon-connection.ts new DaemonConnection': 'the pool itself (getDaemonConnection, getDirectDaemonConnection)',
  'src/providers/remote-session-manager.ts new DaemonConnection': 'a private connection to a direct daemon URL (tests\' per-test daemons)',
}
const EXEMPT = new Set(['src/providers/daemon-standalone.ts', 'src/providers/daemon-source.ts'])
const DIALS = new Set(['getDaemonConnection', 'getDirectDaemonConnection'])

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sourceFiles(p, out)
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

/** `<file> <entry>` for every call of a dial entry point and every `new DaemonConnection(...)`. */
function dialSites(): Array<{ site: string; call: ts.CallExpression | ts.NewExpression }> {
  const out: Array<{ site: string; call: ts.CallExpression | ts.NewExpression }> = []
  for (const file of sourceFiles(path.join(repoRoot, 'src'))) {
    const f = rel(file)
    if (EXEMPT.has(f)) continue
    const text = fs.readFileSync(file, 'utf8')
    if (!/DaemonConnection/.test(text)) continue
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const e = n.expression
        const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null
        if (name && DIALS.has(name)) out.push({ site: `${f} ${name}`, call: n })
      }
      if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'DaemonConnection') out.push({ site: `${f} new DaemonConnection`, call: n })
      ts.forEachChild(n, visit)
    }
    visit(parse(file))
  }
  return out
}

/** The text of a top-level function in a file. */
function fnText(file: string, name: string): string {
  const sf = parse(path.join(repoRoot, file))
  let found = ''
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n.getText(sf)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return found
}

describe('dial gate ratchet: every new daemon link passes the gate', () => {
  const sites = dialSites()

  it('every dial site is a known one', () => {
    const unknown = [...new Set(sites.map((s) => s.site))].filter((s) => !(s in DIAL_SITES))
    expect(unknown, 'A new place opens a daemon link. Reach the host through link(host) (src/core/hosts/link.ts), which refuses a host '
      + 'the person removed or turned off and a found host waiting for the yes (dialRefusal). A person\'s own action that must dial '
      + 'directly asks dialRefusal first; then list it here with how it passes the gate.').toEqual([])
  })

  it('no listed site is gone (the list only tightens)', () => {
    const seen = new Set(sites.map((s) => s.site))
    expect(Object.keys(DIAL_SITES).filter((s) => !seen.has(s))).toEqual([])
  })

  it('link() dials a remote host only with the target remoteTarget gave, and remoteTarget asks the gate', () => {
    const body = fnText('src/core/hosts/link.ts', 'link')
    const calls = sites.filter((s) => s.site === 'src/core/hosts/link.ts getDaemonConnection').map((s) => s.call.getText())
    expect(calls).toHaveLength(3)
    // The local daemon and a replica's own host by their own names; every other key through the gate.
    expect(calls.filter((c) => !/\{ hostname: (LOCAL_LINK|key) \}/.test(c))).toEqual(['dc.getDaemonConnection(key, await remoteTarget(key))'])
    expect(body).toMatch(/if \(key === LOCAL_LINK\) return/)
    expect(body).toMatch(/if \(isSelfHost\(key\)\) return/)
    const gate = fnText('src/core/hosts/link.ts', 'remoteTarget')
    expect(gate).toContain('dialRefusal(')
    expect(gate).toContain('throw new UnknownHostError(key, hit.refusal)')
  })

  it('a person\'s Connect asks the same gate before it dials', () => {
    const body = fnText('src/core/hosts/host-connect-action.ts', 'connectHostNow')
    const gate = body.indexOf('dialRefusal(def)')
    expect(gate).toBeGreaterThan(0)
    for (const dial of ['reconnectHostNow(', 'getDaemonConnection(', 'warmup.kick(']) {
      expect(body.indexOf(dial), dial).toBeGreaterThan(gate)
    }
  })

  it('the local sites name only this machine', () => {
    for (const { site, call } of sites) {
      const arg = (call.arguments ?? [])[0]?.getText()
      if (site === 'src/web/local-daemon-lane.ts getDaemonConnection') expect(arg).toBe('LOCAL')
      if (/(oneshot-client|local-daemon-dial|acp-session|demo-server)\.ts getDirectDaemonConnection$/.test(site)) expect(arg).toBe("'__local__'")
    }
  })
})

describe('link(): the gate refuses before any dial', () => {
  beforeEach(() => {
    state.dials = []
    state.reads = 0
    resetLinkTargetsForTest()
  })

  it('a host turned off, a found host waiting or Not now, and a host not in config are refused; nothing dials', async () => {
    state.hosts = {
      'off-box': { hostname: 'off-box.invalid', enabled: false },
      'ask-box': { hostname: 'ask-box.invalid', discovered: true, connect: 'ask', enabled: false },
      'later-box': { hostname: 'later-box.invalid', discovered: true, connect: 'not_now', enabled: false },
    }
    const refused = async (host: string) => link(host).then(() => null, (err: unknown) => err)
    const off = await refused('off-box')
    expect(off).toBeInstanceOf(UnknownHostError)
    expect(off).toMatchObject({ name: 'UnknownHostError', why: 'off' })
    expect(await refused('ask-box')).toMatchObject({ why: 'waiting' })
    expect(await refused('later-box')).toMatchObject({ why: 'waiting' })
    expect(await refused('gone-box')).toMatchObject({ why: 'unknown', message: 'Unknown host: gone-box' })
    expect(state.dials).toEqual([])
  })

  it('a host on, the person\'s yes, Walnut\'s own yes and an undecided older found row are dialled as before', async () => {
    state.hosts = {
      'on-box': { hostname: 'on-box.invalid', enabled: true },
      'plain-box': { hostname: 'plain-box.invalid' },
      'yes-box': { hostname: 'yes-box.invalid', discovered: true, connect: 'yes', enabled: true },
      'walnut-yes': { hostname: 'walnut-yes.invalid', discovered: true, connect: 'yes', connect_by: 'walnut', enabled: true },
      'older-row': { hostname: 'older-row.invalid', discovered: true, enabled: true },
    }
    for (const h of Object.keys(state.hosts)) await link(h)
    await link('__local__')
    expect(state.dials).toEqual([...Object.keys(state.hosts), '__local__'])
  })

  it('a host removed in Settings that ~/.ssh/config also names comes back waiting for the yes: never dialled', async () => {
    // What getConfig reads after the Remove (config-manager.ts mergeSshDiscoveredHosts): config.yaml without
    // the row, the Host block merged back as a found host, and the read rule.
    const config = { hosts: {}, hosts_found: { asking_since: '2026-11-23T00:00:00.000Z' } } as unknown as Config
    mergeFoundHosts(config, new Map([['gone-box', { alias: 'gone-box', hostname: '127.0.0.1', user: 'runner', port: 2222 }]]), { asking: true })
    applyFoundHostAnswers(config.hosts)
    expect(config.hosts!['gone-box']).toMatchObject({ discovered: true, connect: 'ask', enabled: false })
    state.hosts = config.hosts as Record<string, unknown>
    await expect(link('gone-box')).rejects.toMatchObject({ name: 'UnknownHostError', why: 'waiting' })
    expect(state.dials).toEqual([])
  })

  it('a host that leaves Settings is refused at once: its cached target does not outlive the leave', async () => {
    state.hosts = { devbox: { hostname: 'devbox.invalid', enabled: true } }
    await link('devbox')
    expect(state.dials).toEqual(['devbox'])
    // The Remove: the row comes back as a found host waiting for the yes, and the server ends the link.
    state.hosts = { devbox: { hostname: 'devbox.invalid', discovered: true, connect: 'ask', enabled: false } }
    await endHostLink('devbox', {
      dropConnection: () => true, endTerminalMaster: async () => false, leaveServiceSet: async () => ({ own: false, ok: true, why: '' }),
    }, { removed: true })
    await expect(link('devbox')).rejects.toMatchObject({ why: 'waiting' })
    expect(state.dials).toEqual(['devbox'])
  })

  it('the refusal is cached like a target (no config read per file read), and forgotten by the same calls', async () => {
    state.hosts = { 'off-box': { hostname: 'off-box.invalid', enabled: false } }
    await expect(link('off-box')).rejects.toThrow(UnknownHostError)
    await expect(link('off-box')).rejects.toThrow(UnknownHostError)
    expect(state.reads).toBe(1)
  })

  it('dialRefusal reads one row', () => {
    expect(dialRefusal(undefined)).toBeNull()
    expect(dialRefusal({ enabled: true })).toBeNull()
    expect(dialRefusal({ enabled: false })).toBe('off')
    expect(dialRefusal({ discovered: true, connect: 'ask' })).toBe('waiting')
    expect(dialRefusal({ discovered: true, connect: 'yes', connect_by: 'walnut' })).toBeNull()
  })
})
