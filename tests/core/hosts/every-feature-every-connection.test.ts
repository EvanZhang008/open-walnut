/**
 * Class guard, the server half: every feature that does work ON a host takes a route
 * there whatever the connection (the user, 2026-11-18: "make sure all feature is
 * availble. no matter the connection ntype"; "connection is an abstraction").
 * 2026-11-18: after two hosts moved from SSH to the host network, the terminal, the
 * web preview, the embedded editor and plugin jobs each still assumed SSH somewhere.
 *
 *   1. Every kind of daemon link (daemon-update-paths.ts DAEMON_LINK_KINDS, read at
 *      run time) is classified here; each remote kind runs a port forward (web preview,
 *      embedded editor), a script and a checked upload (host server, plugin jobs) on a
 *      real DaemonConnection: over ssh exactly where the host has an SSH route, else
 *      over the daemon link, and never refused for its kind.
 *   2. Every config kind (each `transport` the source names, with and without
 *      `cloud_box`) gets a terminal route (terminal-every-host-kind.test.ts holds the
 *      spawn half), a preview target for a URL naming it, and a status frame that names
 *      its route, so what only SSH can do (VS Code desktop) says why there.
 *   3. Source ratchet: every file that branches on the connection kind is listed with
 *      why that branch is fine. A new branch fails until someone decides it gives every
 *      kind the feature (or says why it cannot, in the UI).
 * The UI half (nothing hides silently) is tests/web/host-feature-every-connection.test.ts.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const linkRuns = vi.hoisted(() => [] as string[])
vi.mock('../../../src/providers/daemon-net-update-io.js', () => ({
  createNetUpdateIo: () => ({ run: async (script: string) => { linkRuns.push(script); return '' } }),
}))
const partWrites = vi.hoisted(() => [] as string[])
vi.mock('../../../src/core/transfer/daemon-transfer-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/transfer/daemon-transfer-client.js')>()),
  writeFileInParts: async (_host: string, p: string, data: Buffer) => {
    partWrites.push(p)
    const { createHash } = await import('node:crypto')
    return { done: true, sha256: createHash('sha256').update(data).digest('hex') }
  },
}))

import { DaemonConnection } from '../../../src/providers/daemon-connection.js'
import { DAEMON_LINK_KINDS, type DaemonLinkKind } from '../../../src/providers/daemon-update-paths.js'
import { CLOUD_BOX_HOST_ALIAS } from '../../../src/core/hosts/cloud-box-host.js'
import { TERMINAL_ROUTE_BY_TRANSPORT, hostHasSshRoute, hostRouteFields, hostTerminalNow, terminalRouteKind } from '../../../src/core/hosts/host-status.js'
import { resolveServiceTarget } from '../../../src/core/session-service-preview.js'
import { createLeaderSide } from '../../../src/core/session-channel/leader-side.js'
import { SESSION_LINK_KINDS, type ChannelSocket, type SessionLinkKind } from '../../../src/core/session-channel/leader-links.js'

const ROOT = path.resolve(__dirname, '../../..')

/** How each link kind runs the host features below; a new kind fails until it is named here. */
const LINK_KIND_FEATURES: Record<DaemonLinkKind, { remote: boolean; why: string }> = {
  local: { remote: false, why: 'this machine: its services, scripts and files are here, no forward or upload needed' },
  ssh: { remote: true, why: 'ssh -L, ssh sh -s and the marked upload over the host\'s ssh' },
  net: { remote: true, why: 'port streams, exec and checked parts over the daemon link' },
  'cloud-tunnel': { remote: true, why: 'the same daemon link, through the companion\'s tunnel (frames pass verbatim)' },
  'direct-url': { remote: false, why: 'a connection dialled straight to a daemon URL (tests, the replica check); its host row decides as for any host' },
}

/** A DaemonConnection of each remote kind, connected to a daemon with every capability. */
function connectionOf(kind: DaemonLinkKind): DaemonConnection {
  const conn = kind === 'cloud-tunnel'
    ? new DaemonConnection(CLOUD_BOX_HOST_ALIAS, { hostname: 'companion.example.test' })
    : kind === 'net'
      ? new DaemonConnection('joined-box', { hostname: 'joined-box.walnut-net.invalid', via: 'net', endpoint: 'ab'.repeat(32) } as never)
      : new DaemonConnection('devbox', { hostname: 'dev.example.test', user: 'alice' })
  expect(conn.linkKind).toBe(kind)
  vi.spyOn(conn, 'hasCapability').mockReturnValue(true)
  return conn
}

describe('every kind of daemon link runs the host features', () => {
  it('every link kind is classified (read from the source)', () => {
    expect([...DAEMON_LINK_KINDS].sort()).toEqual(Object.keys(LINK_KIND_FEATURES).sort())
  })

  for (const kind of DAEMON_LINK_KINDS.filter((k) => LINK_KIND_FEATURES[k].remote)) {
    it(`${kind}: a port forward, a script and a checked upload each take a route, ssh only where there is one`, async () => {
      const conn = connectionOf(kind)
      const inner = conn as unknown as Record<string, (...a: unknown[]) => unknown>
      const ssh = vi.spyOn(inner, 'sshExec' as never).mockResolvedValue('' as never)
      const sshForward = vi.spyOn(inner, 'dialPortForward' as never).mockResolvedValue(40001 as never)
      const linkForward = vi.spyOn(inner, 'dialLinkPortForward' as never).mockResolvedValue(40002 as never)
      linkRuns.length = 0
      partWrites.length = 0
      const overSsh = kind === 'ssh'

      // The web preview's and the embedded editor's forward.
      const port = await conn.ensurePortForward(5173, '127.0.0.1')
      expect(port).toBe(overSsh ? 40001 : 40002)
      expect(sshForward).toHaveBeenCalledTimes(overSsh ? 1 : 0)
      expect(linkForward).toHaveBeenCalledTimes(overSsh ? 0 : 1)

      // The host server's and plugin jobs' scripts.
      await conn.runRemoteScript('echo ok')
      expect(linkRuns.includes('echo ok')).toBe(!overSsh)

      // A checked upload (host server bundle, plugin job files): over the link in parts.
      if (!overSsh) {
        await conn.uploadFile('/tmp/walnut-guard/file.bin', Buffer.from('payload'))
        expect(partWrites).toEqual(['/tmp/walnut-guard/file.bin'])
      }
      if (!overSsh) expect(ssh).not.toHaveBeenCalled()
    })
  }

  it('a link daemon without the capability names the update, never "not SSH"', async () => {
    for (const kind of ['net', 'cloud-tunnel'] as const) {
      const conn = connectionOf(kind)
      ;(conn.hasCapability as unknown as { mockReturnValue(v: boolean): void }).mockReturnValue(false)
      for (const attempt of [conn.ensurePortForward(5173, '127.0.0.1'), conn.runRemoteScript('true'), conn.uploadFile('/tmp/x', Buffer.from('x'))]) {
        const err = await attempt.then(() => null, (e: Error) => e)
        expect(err?.message, kind).toMatch(/update/i)
        expect(err?.message, kind).not.toMatch(/not (available|SSH)|over SSH only/i)
      }
    }
  })
})

/** The string members of `transport?: 'a' | 'b'` after `anchor` in a source file. */
function transportUnion(file: string, anchor: string): string[] {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const at = src.indexOf(anchor)
  expect(at, anchor).toBeGreaterThan(-1)
  const m = /transport\?:\s*((?:'[a-z-]+'\s*\|?\s*)+)/.exec(src.slice(at))
  expect(m, `the transport union after ${anchor}`).toBeTruthy()
  return [...m![1]!.matchAll(/'([a-z-]+)'/g)].map((x) => x[1]!)
}

const TRANSPORTS = [...new Set([
  ...transportUnion('src/core/types.ts', 'hosts?: Record<string, {'),
  ...transportUnion('src/core/hosts/host-status.ts', 'export interface HostDef {'),
])]

describe('every kind of configured host', () => {
  const kinds = [undefined, ...TRANSPORTS].flatMap((transport) => [false, true].map((cloud) => {
    const key = cloud ? CLOUD_BOX_HOST_ALIAS : `box-${transport ?? 'default'}`
    const hostname = transport === 'net' ? `${key}.walnut-net.invalid` : cloud ? 'companion.example.test' : 'dev.example.test'
    return { key, def: { hostname, ...(transport ? { transport } : {}), ...(cloud ? { cloud_box: true } : {}) } as { hostname: string; transport?: 'ssh' | 'net'; cloud_box?: boolean } }
  }))

  it('the kinds are read from the source', () => {
    expect(TRANSPORTS).toEqual(expect.arrayContaining(['ssh', 'net']))
    expect(Object.keys(TERMINAL_ROUTE_BY_TRANSPORT).sort()).toEqual([...TRANSPORTS].sort())
  })

  for (const { key, def } of kinds) {
    it(`${key} (${def.transport ?? 'unset'}${def.cloud_box ? ', cloud box' : ''}): a terminal, a preview target, and a frame naming its route`, () => {
      // Terminal: a route of either kind, available now (the spawn half: terminal-every-host-kind.test.ts).
      expect(['ssh', 'link']).toContain(terminalRouteKind(def))
      expect(hostTerminalNow(def, {}, key)).toBe(true)
      // Web preview: a URL naming the host reaches it, by its alias on every kind; an SSH host by its
      // row's name too, a link host by the name its machine gives (and its own placeholder name from its
      // own session). The cloud box's row name is the companion's public domain: a plain link, never its loopback.
      const link = !hostHasSshRoute(def)
      const names: Array<[string, boolean]> = [[key, true], [def.hostname, !def.cloud_box], ['machine-own-name', link]]
      for (const [name, reaches] of names) {
        const target = resolveServiceTarget(new URL(`http://${name}:5173/`), {
          sessionHost: key, hosts: { [key]: def }, localNames: ['this-mac'], machineNames: { [key]: ['machine-own-name'] },
        })
        expect(target?.host ?? null, `${key} via ${name}`).toBe(reaches ? key : null)
        if (reaches) expect(target!.targets.length).toBeGreaterThan(0)
      }
      // The frame says when there is no SSH route, so the UI can say why for what only SSH does.
      const fields = hostRouteFields(def)
      expect(fields.ssh === false).toBe(!hostHasSshRoute(def))
      if (fields.ssh === false) expect(['host-network', 'cloud']).toContain(fields.via)
    })
  }
})

/**
 * Every file that branches on how a host is connected, and why its branch keeps every
 * feature on every kind (a route per kind, an inherent limit the UI explains, display only,
 * or the connection machinery itself), the cloud box's alias compared included (2026-11-18 review:
 * plugin jobs had dropped the cloud box by `key !== CLOUD_BOX_HOST_ALIAS`). Count = matching lines;
 * a new file or more lines fail.
 */
const BRANCH = String.raw`hostHasSshRoute\(|transport (===|!==) '(ssh|net)'|\.cloud_box\b|\bisNetHost\b|\bisCloudTunnel\b|\bnoSsh\b|linkKind (===|!==)|\blink (===|!==) '(ssh|net|cloud-tunnel)'|(===|!==) CLOUD_BOX(_HOST)?_ALIAS\b|\bCLOUD_BOX(_HOST)?_ALIAS (===|!==)|(===|!==) '__cloudbox__'|'__cloudbox__' (===|!==)`
const BRANCHING_FILES: Record<string, { max: number; why: string }> = {
  'src/commands/demo-ssh-masters.ts': { max: 1, why: 'the demo\'s ssh masters: demo only' },
  'src/core/expose/placement.ts': { max: 2, why: 'where a host server\'s page is exposed: the cloud box is itself public, so it is not a candidate' },
  'src/core/host-replica.ts': { max: 1, why: 'which keep settings a host\'s replica takes: the cloud box keeps the companion\'s, every other host its own' },
  'src/core/host-server/follower-default.ts': { max: 1, why: 'the cloud box is a Walnut server itself: it gets no follower by default, as no host server of this Mac runs there (index.ts, the route\'s 409)' },
  'src/core/host-server/index.ts': { max: 1, why: 'the cloud box is a Walnut server itself (CLOUD_BOX_HOST_SERVER_NOTE): no host server of this Mac runs there, and the UI says so' },
  'src/core/hosts/cloud-box-host.ts': { max: 3, why: 'which row is the cloud box: the connection machinery' },
  'src/core/hosts/fleet.ts': { max: 2, why: 'the fleet rows: display, and the cloud box\'s host-server note' },
  'src/core/hosts/found-host-alert.ts': { max: 1, why: 'an alert about a host found in ssh config: SSH only by nature' },
  'src/core/hosts/host-auth-alert.ts': { max: 1, why: 'SSH sign-in alerts: nothing to sign in to on the Mac or the cloud box' },
  'src/core/hosts/host-connect-action.ts': { max: 2, why: 'a person\'s Retry on Cloud may mint a new credential: both kinds connect' },
  'src/core/hosts/host-display-name.ts': { max: 1, why: 'the cloud box reads Cloud: display' },
  'src/core/hosts/host-link-end.ts': { max: 1, why: 'ends a host\'s ssh masters: the Mac and the cloud box have none' },
  'src/core/hosts/host-readiness.ts': { max: 2, why: 'the sign-in hint names ssh only for an SSH host: wording' },
  'src/core/hosts/host-status.ts': { max: 9, why: 'the route decision itself (terminalRouteKind, hostRouteFields) and the status frame' },
  'src/core/hosts/joined-twins.ts': { max: 2, why: 'one machine joined twice: connection setup' },
  'src/core/hosts/daemon-twins.ts': { max: 1, why: 'which alias of one daemon carries the machine: a host-network row only while the host network is on; every alias keeps working' },
  'src/core/hosts/link.ts': { max: 1, why: 'which connection a host gets: the connection machinery' },
  'src/core/hosts/placement.ts': { max: 3, why: 'automatic picks leave the small, paid cloud box out; the Move to host menu lists it (hostLoads cloudBox)' },
  'src/core/hosts/ssh-cert-expiry-alert.ts': { max: 1, why: 'an alert about SSH certificates: SSH only by nature' },
  'src/core/net/net-adopt.ts': { max: 4, why: 'moving a host onto the host network: connection setup' },
  'src/core/net/net-hosts.ts': { max: 3, why: 'host network bookkeeping: connection setup' },
  'src/core/net/net-mac.ts': { max: 2, why: 'host network bookkeeping: connection setup' },
  'src/core/net/net-rows.ts': { max: 1, why: 'host network rows in Settings: display' },
  'src/core/self-repair/host-fix-record.ts': { max: 1, why: 'a host problem record names the kind: display' },
  'src/core/session-tracker.ts': { max: 2, why: 'the cloud box\'s smaller default session limits (a small shared instance): session_limits wins' },
  'src/core/session-vscode-uri.ts': { max: 2, why: 'VS Code desktop opens remote folders over SSH only; the menu says so and opens the Code view (frame `ssh: false`)' },
  'src/core/sessions/mobile-launch.ts': { max: 1, why: 'the phone\'s host list drops the cloud box only while it refuses this Mac (it says why there)' },
  'src/core/sessions/session-extras.ts': { max: 1, why: 'wording of a host in a session\'s extras: display' },
  'src/core/transfer/workspace.ts': { max: 1, why: 'host-to-host copy uses scp where both have ssh, else relays through this Mac: both move the workspace' },
  'src/lib/cloud-session-payload.ts': { max: 1, why: 'the cloud relay fallback for a host whose direct link is down: the cloud box is reached through the companion already' },
  'src/providers/daemon-connection.ts': { max: 35, why: 'the connection: one ssh branch and one link branch (noSsh) per feature, both working; the service mode of a host network host goes through its own updater (noSsh), and the cloud box is never offered the one-service switch (isCloudTunnel)' },
  'src/providers/demo-remote-host.ts': { max: 1, why: 'the demo\'s own ssh host: demo only' },
  'src/providers/ephemeral-replica-host.ts': { max: 1, why: 'a test server\'s replica check: tests only' },
  'src/providers/remote-isolation.ts': { max: 2, why: 'a test server\'s own daemon needs ssh to place it: tests only' },
  'src/providers/remote-session-manager.ts': { max: 2, why: 'the cloud relay fallback for a host whose direct link is down: the cloud box is reached through the companion already' },
  'src/web/routes/bridge-send.ts': { max: 1, why: 'the cloud relay fallback for a host whose direct link is down: the cloud box is reached through the companion already' },
  'src/web/routes/browser-pair.ts': { max: 1, why: 'sign-in addresses of this Mac\'s host servers: the cloud box is a server of its own' },
  'src/web/routes/host-servers.ts': { max: 3, why: 'the cloud box refused with the sentence why (409 cloud_box_is_a_walnut_server)' },
  'src/web/routes/hosts-net.ts': { max: 1, why: 'host network setup routes: connection setup' },
  'src/web/routes/session-launch-v1.ts': { max: 1, why: 'whether the primary lists this box, for the phone\'s launcher: display' },
  'src/web/server.ts': { max: 1, why: 'wiring' },
  'src/web/terminal/dtach-lifecycle.ts': { max: 1, why: 'the terminal lifecycle over its route (terminal-route.ts)' },
  'src/web/terminal/terminal-route.ts': { max: 1, why: 'the terminal route: ssh or the link, both open a terminal' },
  'src/web/ws/bridge-session-stream.ts': { max: 1, why: 'the cloud relay fallback for a host whose direct link is down: the cloud box is reached through the companion already' },
  'web/src/components/first-run/first-run-model.ts': { max: 1, why: 'first-run wording per connection kind: display' },
  'web/src/components/sessions/DraftLaunchPills.tsx': { max: 1, why: 'names a host\'s alias beside its label, not the cloud box\'s internal one: display' },
  'web/src/components/settings/sections/RemoteHostsSection.tsx': { max: 3, why: 'Settings rows by connection kind, and how a machine is also reached: display' },
  'web/src/components/settings/sections/remote-hosts-model.ts': { max: 2, why: 'Settings rows by connection kind: display' },
  'web/src/components/settings/sections/useSshHostEditor.ts': { max: 1, why: 'editing an SSH host\'s ssh fields: SSH only by nature' },
  'web/src/utils/host-display-label.ts': { max: 2, why: 'Cloud\'s label and route word: display' },
}

describe('every branch on the connection kind is a decided one', () => {
  it('lists each file that branches, with why every kind keeps the feature', () => {
    const out = execFileSync('git', ['grep', '-cP', BRANCH, '--', 'src', 'web/src', ':!*.test.*', ':!*.spec.*'], { cwd: ROOT, encoding: 'utf8' })
    const found = Object.fromEntries(out.trim().split('\n').filter(Boolean).map((l) => {
      const i = l.lastIndexOf(':')
      return [l.slice(0, i), Number(l.slice(i + 1))]
    }))
    const unlisted = Object.keys(found).filter((f) => !Object.hasOwn(BRANCHING_FILES, f))
    expect(unlisted, 'a new branch on the connection kind: give every kind the feature (or say why in the UI), then list it here').toEqual([])
    const over = Object.entries(found).filter(([f, n]) => n > BRANCHING_FILES[f]!.max).map(([f, n]) => `${f}: ${n} > ${BRANCHING_FILES[f]!.max}`)
    expect(over, 'more branches in a listed file: check each still gives every kind the feature, then raise its max').toEqual([])
  })
})

/**
 * The session channel's links (src/core/session-channel/leader-links.ts SESSION_LINK_KINDS): a
 * host that runs its sessions is reached the way the leader dialed it, or over the socket the host
 * dialed into the leader's door. Each kind carries the channel and every host call; only what must
 * ride the host's authenticated daemon link (the door credential's issue) is said to need it.
 * `e2e`: the cluster test (every piece a real process) where a host-judged session is started,
 * streamed (each fact once, in order) and operated (a send, an interrupt) over that kind alone.
 */
const SESSION_LINK_FEATURES: Record<SessionLinkKind, { channel: string; calls: string; issue: string; e2e: { file: string; tests: string[] } }> = {
  'leader-dialed': { channel: 'a WebSocket on a session-channel stream through the host\'s daemon link', calls: 'one HTTP request per call on a session-call stream', issue: 'over this link (POST /host-api/credential)', e2e: { file: 'tests/e2e/host-dialed-door-e2e.test.ts', tests: ['K1'] } },
  'host-dialed': { channel: 'the socket the host dialed into /host-door, after both proved who they are', calls: 'call/reply frames on the same socket, answered by the host\'s route table', issue: 'never: a credential is issued only over the daemon link, so a host reached only this way keeps the one it holds', e2e: { file: 'tests/e2e/host-dialed-door-e2e.test.ts', tests: ['D2', 'D3'] } },
}

/**
 * The other ways a host-judged session is reached that are no leader link, each with its test or
 * why it does not apply. A new way (a leader link kind above, or a reader beside them) is added here.
 */
const OTHER_SESSION_LINKS: Record<string, { what: string; e2e?: { file: string; tests: string[] }; notApplicable?: string }> = {
  'companion-listener': {
    what: 'the host dials its cloud companion\'s /host-listen with its own /bridge machine token; the companion reads (rows, facts, flow) and, while the Mac is away, operates the session by call frames (send, interrupt, a prompt\'s answer). A start is not callable there (C5b Amendment 6: its bundle is the leader\'s to build)',
    e2e: { file: 'tests/e2e/companion-host-listener-e2e.test.ts', tests: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'] },
  },
  local: {
    what: 'a session on the leader\'s own machine',
    notApplicable: 'the leader\'s own machine has no host service of its own: its runtime is the leader\'s (in its process or its own daemon), and the leader\'s runner runs and judges those sessions itself (judge-of.ts: a row of this server is never \'host\'), so there is no channel link to it. A host entry that names the leader\'s own machine is a host like any other (its own service and home) and links by one of the kinds above: every cluster test runs exactly that, all its processes on one machine',
  },
}

describe('every kind of session channel link carries the channel and the host calls', () => {
  it('every kind is classified (read from the source)', () => {
    expect([...SESSION_LINK_KINDS].sort()).toEqual(Object.keys(SESSION_LINK_FEATURES).sort())
  })

  it('every kind, and every other way a host-judged session is reached, names its cluster test or why none applies', () => {
    const named = [...Object.values(SESSION_LINK_FEATURES).map((f) => f.e2e), ...Object.values(OTHER_SESSION_LINKS).flatMap((f) => (f.e2e ? [f.e2e] : []))]
    for (const { file, tests } of named) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
      for (const id of tests) expect(src, `${file} names ${id}`).toMatch(new RegExp(`\\bit\\('${id}: `))
    }
    for (const [kind, f] of Object.entries(OTHER_SESSION_LINKS)) expect(!!f.e2e !== !!f.notApplicable, `${kind}: a test or why none applies, one of the two`).toBe(true)
  })

  for (const kind of SESSION_LINK_KINDS) {
    it(`${kind}: a send to a host session takes this link's own way`, async () => {
      const opened: string[] = []
      const framed: string[] = []
      const side = createLeaderSide({
        walnutId: async () => 'w1', permit: () => ({ permitNumber: 0, epoch: 1 }), switchNow: async () => () => true,
        openStream: async (_h, purpose) => { opened.push(purpose); throw new Error('no daemon link in this test') },
        ...(kind === 'leader-dialed' ? { dial: async () => fakeSocket() } : {}),
        applyBatch: async () => ({ written: [], skipped: [] }), loadCursor: async () => null,
        emit: () => {}, noteLive: () => {}, noteRename: () => {}, noteHostJudged: () => {}, ownerOf: () => 'devbox', log: () => {},
      })
      try {
        if (kind === 'host-dialed') side.adopt('devbox', { ...fakeSocket(), kind: 'host-dialed', call: async (_m, route) => { framed.push(route); return { status: 200, body: { ok: true } } } })
        else await side.noteHost('devbox', { connected: true, judges: true })
        await vi.waitFor(() => expect(side.linkKind('devbox')).toBe(kind))
        const sent = side.sendToHost('devbox', { sessionId: 's1', message: 'hi' })
        if (kind === 'host-dialed') {
          await expect(sent).resolves.toMatchObject({ ok: true })
          expect(framed).toEqual(['/host-api/sessions/send'])
          expect(opened).toEqual([])
        } else {
          // The stream way: this test has no daemon link, so the request is said never sent.
          await expect(sent).rejects.toMatchObject({ notSent: true })
          expect(opened).toEqual(['session-call'])
        }
      } finally {
        side.stop()
      }
    })
  }
})

function fakeSocket(): ChannelSocket {
  return { send: () => {}, close: () => {}, onMessage: () => {}, onClose: () => {} }
}
