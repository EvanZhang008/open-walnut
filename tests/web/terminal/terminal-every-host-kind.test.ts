/**
 * Class guard: a terminal opens on EVERY kind of host, whatever the connection
 * (the user, 2026-11-18: "it should always have ... no matter what connection,
 * connection is an abstraction"). 2026-11-18: two hosts moved from SSH to the host
 * network and every session there lost its Terminal, because a terminal was an
 * `ssh -tt` and nothing else.
 *
 * The kinds are read from the source, not listed by hand: every member of the
 * `transport` union of a config host (src/core/types.ts) and of host-status's
 * HostDef, each with and without `cloud_box`, plus every kind of daemon link
 * (daemon-update-paths.ts DAEMON_LINK_KINDS). Each must
 *   - have a row in TERMINAL_ROUTE_BY_TRANSPORT (checked at run time, so a new value
 *     fails here even where nothing type-checks), and resolve a route spawn.ts can take;
 *   - make resolveSpawnForSession take a path that works for it: ssh only to a host
 *     with an SSH route (a real hostname, never `.walnut-net.invalid` or the cloud
 *     box), and the daemon link (a terminal stream) for every other, with the SAME
 *     remote command an SSH host's ssh carries.
 * A new transport value fails here until it is given its terminal.
 *
 * Also the regression half: an SSH host's ssh argv is exactly what it was.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { SessionRecord } from '../../../src/core/types.js'

vi.mock('../../../src/lib/pty.js', () => ({ loadPty: vi.fn() }))
vi.mock('../../../src/web/terminal/dtach-provision.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/web/terminal/dtach-provision.js')>()),
  remoteDtachPath: vi.fn(async () => '/home/u/.local/bin/walnut-dtach'),
}))
vi.mock('../../../src/web/terminal/link-pty.js', () => ({ openLinkPty: vi.fn(async () => ({ via: 'link' })) }))
vi.mock('../../../src/core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/config-manager.js')>()),
  getConfig: vi.fn(),
}))

import { resolveSpawnForSession, resolveTerminalRoute, buildRemoteSshArgs, buildRemotePlainSshArgs, buildRemoteDtachCommand, buildRemotePlainShellCommand, sshControlMasterArgs } from '../../../src/web/terminal/spawn.js'
import { TERMINAL_ROUTE_BY_TRANSPORT, terminalRouteKind, hostTerminalNow, hostHasSshRoute } from '../../../src/core/hosts/host-status.js'
import { DAEMON_LINK_KINDS } from '../../../src/providers/daemon-update-paths.js'
import { CLOUD_BOX_HOST_ALIAS } from '../../../src/core/hosts/cloud-box-host.js'
import { loadPty } from '../../../src/lib/pty.js'
import { openLinkPty } from '../../../src/web/terminal/link-pty.js'
import { getConfig } from '../../../src/core/config-manager.js'

const ROOT = path.resolve(__dirname, '../../..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')

/** The string members of `transport?: 'a' | 'b'` in a block of source. */
function transportUnion(src: string, anchor: string): string[] {
  const at = src.indexOf(anchor)
  expect(at, anchor).toBeGreaterThan(-1)
  const m = /transport\?:\s*((?:'[a-z-]+'\s*\|?\s*)+)/.exec(src.slice(at))
  expect(m, `the transport union after ${anchor}`).toBeTruthy()
  return [...m![1]!.matchAll(/'([a-z-]+)'/g)].map((x) => x[1]!)
}

const TRANSPORTS = [...new Set([
  ...transportUnion(read('src/core/types.ts'), 'hosts?: Record<string, {'),
  ...transportUnion(read('src/core/hosts/host-status.ts'), 'export interface HostDef {'),
])]

/** Every daemon link kind, and how a terminal reaches a host linked that way. */
const LINK_KIND_TERMINAL: Record<string, string> = {
  local: 'this machine: a local pty under dtach (no route needed)',
  ssh: 'ssh -tt over the terminal ControlMaster',
  net: 'a terminal stream on the daemon link (pty-stream-v1)',
  'cloud-tunnel': 'a terminal stream on the daemon link (pty-stream-v1): the companion pipes every frame verbatim (web/ws/daemon-tunnel.ts)',
  'direct-url': 'a connection dialled straight to a daemon URL (tests, the replica check); its host\'s config row decides ssh or the link as for any host',
}

const REMOTE_DTACH = '/home/u/.local/bin/walnut-dtach'
const SID = '7b370f7c-c1bd-4961-b7cf-2a69d34d5854'
const ptySpawn = vi.fn((_file: string, _args: string[]) => ({ via: 'ssh' }))

type Def = { hostname: string; user?: string; transport?: string; cloud_box?: boolean; endpoint?: string; label?: string }
const kinds: Array<{ key: string; def: Def; why: string }> = []
for (const transport of [undefined, ...TRANSPORTS]) {
  for (const cloud of [false, true]) {
    const key = cloud ? CLOUD_BOX_HOST_ALIAS : `box-${transport ?? 'default'}`
    const hostname = transport === 'net' ? `${key}.walnut-net.invalid` : cloud ? 'companion.example.test' : 'dev.example.test'
    kinds.push({
      key, why: `transport ${transport ?? '(unset)'}${cloud ? ', cloud box' : ''}`,
      def: { hostname, user: 'alice', ...(transport ? { transport } : {}), ...(cloud ? { cloud_box: true } : {}), ...(transport === 'net' ? { endpoint: 'a'.repeat(64) } : {}) },
    })
  }
}

const record = (host: string): SessionRecord => ({ claudeSessionId: SID, cwd: '/srv/proj', host } as unknown as SessionRecord)

beforeEach(() => {
  ptySpawn.mockClear()
  ;(loadPty as unknown as Mock).mockReset().mockResolvedValue({ spawn: ptySpawn })
  ;(openLinkPty as unknown as Mock).mockClear()
})

describe('every kind of host opens a terminal', () => {
  it('the kinds are read from the source', () => {
    expect(TRANSPORTS).toEqual(expect.arrayContaining(['ssh', 'net']))
    // Every transport the source names has its terminal route: a new value fails here without tsc.
    expect(TRANSPORTS.filter((t) => !Object.hasOwn(TERMINAL_ROUTE_BY_TRANSPORT, t))).toEqual([])
    expect(Object.keys(TERMINAL_ROUTE_BY_TRANSPORT).sort()).toEqual([...TRANSPORTS].sort())
    expect(kinds.length).toBe((TRANSPORTS.length + 1) * 2)
    // Every daemon link kind is named here with how its terminal goes: a new one fails until it is.
    expect([...DAEMON_LINK_KINDS].sort()).toEqual(Object.keys(LINK_KIND_TERMINAL).sort())
  })

  for (const { key, def, why } of kinds) {
    it(`${why}: offers a terminal, and the spawn takes a path that works there`, async () => {
      ;(getConfig as unknown as Mock).mockResolvedValue({ hosts: { [key]: def } })
      const via = terminalRouteKind(def as never)
      expect(['ssh', 'link']).toContain(via)
      expect(via === 'ssh').toBe(hostHasSshRoute(def as never))
      expect(hostTerminalNow(def as never, {}, key)).toBe(true)
      const route = await resolveTerminalRoute(key)
      expect(route.via).toBe(via)
      for (const persistent of [true, false]) {
        ptySpawn.mockClear()
        ;(openLinkPty as unknown as Mock).mockClear()
        await resolveSpawnForSession(record(key), 100, 30, { persistent })
        if (via === 'ssh') {
          expect(openLinkPty).not.toHaveBeenCalled()
          expect(ptySpawn).toHaveBeenCalledTimes(1)
          expect(ptySpawn.mock.calls[0]![0]).toBe('ssh')
          const argv = ptySpawn.mock.calls[0]![1] as string[]
          // ssh only ever dials a real name: never the host network's placeholder nor the cloud box.
          expect(argv.join(' ')).not.toMatch(/walnut-net\.invalid|__cloudbox__|companion\.example\.test/)
        } else {
          expect(ptySpawn).not.toHaveBeenCalled()
          expect(openLinkPty).toHaveBeenCalledTimes(1)
          const [host, command, cols, rows] = (openLinkPty as unknown as Mock).mock.calls[0]!
          expect([host, cols, rows]).toEqual([key, 100, 30])
          // The SAME remote command an SSH host's ssh carries.
          expect(command).toBe(persistent ? buildRemoteDtachCommand(REMOTE_DTACH, SID, undefined, '/srv/proj') : buildRemotePlainShellCommand(undefined, '/srv/proj'))
        }
      }
    })
  }

  it('a host reached over its link, connected to a daemon without terminal streams, says the daemon needs an update, never "not SSH"', () => {
    const net = { hostname: 'x.walnut-net.invalid', transport: 'net' as const }
    const why = hostTerminalNow(net, { noPtyStream: true }, 'Joined box')
    expect(why).toMatch(/The Walnut daemon on Joined box needs an update before it can open a terminal/)
    expect(String(why)).not.toMatch(/ssh/i)
    // An SSH host never depends on its daemon for a terminal.
    expect(hostTerminalNow({ hostname: 'dev.example.test' }, { noPtyStream: true }, 'Dev')).toBe(true)
  })
})

describe('an SSH host keeps exactly the ssh argv it had', () => {
  const HOSTS = { devbox: { hostname: 'dev.example.test', user: 'alice', port: 2222 } }
  const target = { hostname: 'dev.example.test', user: 'alice', port: 2222 }

  it('persistent: ssh -tt ... alice@dev.example.test <the dtach command>', async () => {
    ;(getConfig as unknown as Mock).mockResolvedValue({ hosts: HOSTS })
    await resolveSpawnForSession(record('devbox'), 100, 30)
    const argv = ptySpawn.mock.calls[0]![1] as string[]
    expect(argv).toEqual(buildRemoteSshArgs(REMOTE_DTACH, SID, target, undefined, '/srv/proj', 'devbox'))
    expect(argv).toEqual([
      '-tt', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      ...argv.slice(9, argv.indexOf('-p')), '-p', '2222', ...sshControlMasterArgs('devbox'), 'alice@dev.example.test',
      buildRemoteDtachCommand(REMOTE_DTACH, SID, undefined, '/srv/proj'),
    ])
    expect(openLinkPty).not.toHaveBeenCalled()
  })

  it('plain: the same connection options and the login shell', async () => {
    ;(getConfig as unknown as Mock).mockResolvedValue({ hosts: HOSTS })
    await resolveSpawnForSession(record('devbox'), 100, 30, { persistent: false })
    expect(ptySpawn.mock.calls[0]![1]).toEqual(buildRemotePlainSshArgs(target, '/srv/proj', 'devbox'))
    expect(openLinkPty).not.toHaveBeenCalled()
  })
})
