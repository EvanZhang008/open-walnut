/**
 * The cross-machine rehearsal's world (docs/reference/leader-switch.md, "Rehearsal (a)" and "(b)"): three
 * "machines", each its own folder used as HOME, its own machine id, its own daemon dir and its own REAL daemon (the
 * built standalone twin, the one its server adopts as its own):
 *
 *   A, B     dev boxes that can lead: real, non-ephemeral servers (machine-server.ts). Each reaches
 *            the other machines' daemons only on loopback ports (daemon-routes.ts), each port a
 *            silent-link proxy the test cuts or slows. A's link to B's daemon is the copy link.
 *   H        a third host: only a daemon, where a session runs (the mock Claude CLI)
 *
 * The witnesses are the lead's layout: each dev box's own service and the companion.
 *
 *   w-a      on machine A: A's own server serves its direct door (after a switch, the handed-over
 *            standby of A's home does)
 *   w-b      on machine B: a real host replica on B (`walnut web --replica`, witness-door on) serves
 *            its direct door; in rehearsal (a) A also reaches it over its link to B's host service (way c, a
 *            witness machine on B's state root)
 *   w-k      the companion: the repo's companion test cluster (a WALNUT_CLOUD_MODE replica with
 *            `witness-door` on), behind TLS on loopback. A and B are paired with it (bridge-local)
 *
 * Every link is a startSilentLinkProxy on THIS computer (the cuts and slowdowns are the same code in both
 * rehearsals): A to B's, A to H's, B to A's and B to H's daemon; each door (w-a, w-b, w-k: a door is one proxy, so
 * its cut is that witness out of reach for every machine); in (a), A to B's host service (way c). Each machine's
 * daemon dials the companion through w-k's proxy.
 *
 * Where B is, is its placement (BPlacement): on this computer (makeRemoteWorld, rehearsal (a)), or on another one
 * (real-world.ts, rehearsal (b)): B's processes run there through an agent, every link from B to this computer is a
 * tunnel ending at the same port there, and every read of B's files runs there. A, H and the companion are always
 * here. The scenarios (remote-rehearsal.ts) reach every machine only through this interface, so (a) and (b) run the
 * same checks.
 *
 * Nothing here reads or writes outside `root` (and B's root): no ~/.open-walnut, no :3456, no real companion.
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import YAML from 'yaml'
import { makeMachine, REPO, stopLeftovers, type Machine } from './world.js'
import { windowEnv } from '../../tests/helpers/replica-cluster.js'
import { startSilentLinkProxy, type SilentLinkProxy } from '../../tests/helpers/silent-link-proxy.js'
import { makeLoopbackCert, startTlsFront, type LoopbackCert, type TlsFront } from '../../tests/helpers/loopback-tls.js'
import { seedPrimaryPairing, startCloudBoxReplica, type CloudBoxReplica } from '../../tests/helpers/cloud-box-replica.js'
import { startWitnessMachine, type WitnessMachine } from '../../tests/helpers/witness-machines.js'
import { WITNESS_DOOR_PATH } from '../../src/core/leader/switch/witness-wire.js'
import { installGitWatch, watchEmptyTree } from './git-watch.js'
import type { StartResult } from '../../src/core/leader/switch/side.js'
import { LOCAL, type MachineIO } from './machine-io.js'
import type { SideCall } from './machine-ops.js'

/** A machine's daemon: its dir and bin there, its handle in the ops that keep it, its first door port. */
export interface MachineDaemon { dir: string; bin: string; handle: string; pid: number; port: number }

/** The switch's own side of a machine (side.ts LocalSide), run on that machine. */
export interface MachineSide {
  startServer(mode: 'leader' | 'trial', timeoutMs?: number): Promise<StartResult>
  stopServer(graceMs?: number): Promise<{ wasRunning: boolean }>
  startStandby(timeoutMs?: number): Promise<StartResult>
  /** The pid of the live server on its home that may lead, or null. */
  runningPid(): Promise<number | null>
  /** The pid of the standby of its handed-over home, or null. */
  standbyPid(): Promise<number | null>
}

/** A machine's server started by hand (world.ts ByHand), on that machine. */
export interface ByHandRun { ok: boolean; pid?: number; log: string; logText(): Promise<string>; stop(): Promise<void> }

export interface RemoteWorld {
  root: string
  /** Rehearsal (a): B on this computer; (b): B on another, `label` says which. */
  kind: 'one-box' | 'two-machines'
  label: string
  /** A also reaches w-b over its link to B's host service (way c): rehearsal (a) only. */
  wayC: boolean
  a: Machine
  b: Machine
  h: Machine
  /** How to reach a machine (its files, the readers of its records, its processes). */
  io(m: Machine): MachineIO
  side(m: Machine): MachineSide
  /** One request to a machine's server; `opId` sends x-walnut-op-id. */
  api(m: Machine, method: string, urlPath: string, body?: unknown, opId?: string): Promise<{ status: number; json: any; headers: Headers }>
  /** `walnut <args>` on machine `m` with its home, as a separate process there; its exit and output. */
  cli(m: Machine, args: string[], env?: Record<string, string>): Promise<{ code: number | null; signal: string | null; out: string }>
  /** Machine `m`'s server started by hand there; resolves once it answers /api/leader/status, or exits. */
  byHand(m: Machine, label: string, timeoutMs?: number): Promise<ByHandRun>
  daemons: Record<'a' | 'b' | 'h', MachineDaemon>
  companion: CloudBoxReplica
  /** The links, each a proxy here: `copy` is A to B's daemon (the copy link). */
  links: { copy: SilentLinkProxy; aToH: SilentLinkProxy; bToA: SilentLinkProxy; bToH: SilentLinkProxy; doorA: SilentLinkProxy; doorB: SilentLinkProxy; doorK: SilentLinkProxy; aToBService: SilentLinkProxy | null }
  /** The TLS fronts of the three doors. */
  fronts: { a: TlsFront; b: TlsFront; k: TlsFront }
  /** The witness roots (each machine's state dir), by witness id: paths on that witness's machine. */
  witnessRoot: Record<'w-a' | 'w-b' | 'w-k', string>
  walnutId: string
  /** What the world measured of itself (rehearsal (b): the other machine's clock, the link's round trip). */
  times: Record<string, string>
  /** Why this world takes no large filler (rehearsal (b): the other machine's disk), or null. */
  noFiller?: string | null
  /** Every daemon link one machine's server dials (to the other machines' daemons, and A's to B's host service), cut or back. A door is one proxy for every machine: witnessDown. */
  cutMachine(m: 'a' | 'b', mode: 'drop-hold' | 'severed' | 'pass'): void
  /** One witness out of reach (its door, and in (a) its way c link), and back. */
  witnessDown(id: 'w-a' | 'w-b' | 'w-k', down: boolean): void
  /** Start B's host replica once the Walnut id is known (after A's first boot). */
  startServiceB(walnutId: string): Promise<void>
  /**
   * Rehearsal (b): A's link to w-b's machine for the one-time setup only (a host replica's witness has no setup
   * route on its door: in a real deployment its setup comes over the leader's daemon link to that service). Closed
   * here, after `witnesses init`: from then on A reaches w-b only through its door. False when the world has none.
   */
  endSetupLink(): Promise<boolean>
  stop(): Promise<void>
}

/**
 * Machine B's placement: everything that differs between B on this computer and B on another. Its places are
 * paths on B; `io` reaches B.
 */
export interface BPlacement {
  kind: RemoteWorld['kind']
  label: string
  wayC: boolean
  /** B, as a description (its folder made on B already). */
  b: Machine
  io: MachineIO
  /** PATH of B's processes after its daemon's bin. */
  basePath: string
  /** More env of B's machine (rehearsal (b): TMPDIR and the XDG places inside B's root). */
  envExtra: Record<string, string>
  /** B's copy of the loopback certificate, a path on B (made there now). */
  certOnB(cert: LoopbackCert): Promise<string>
  /** On B, the HOME a route's probe of host `id` runs with (daemon-routes.ts runRemoteScript). */
  routeHomeOnB(id: string): string
  /** On A, the HOME a route's probe of B runs with. */
  routeHomeOfB: string
  /** The walnut program each machine's daemon runs for the standby and the target job (`standby.walnut`). */
  walnut: string[]
  /** This computer's 127.0.0.1:P reaches B's 127.0.0.1:P (the same port), and B's reaches this computer's. */
  forward(port: number): Promise<void>
  /** A forward closed again (the setup-only link once w-b is set up). */
  unforward(port: number): Promise<void>
  reverse(port: number): Promise<void>
  /** The port B's daemon publishes now (daemon.port), as a link to it dials at each connect. */
  daemonPort(d: MachineDaemon): () => number
  /** What the placement measured (printed as TIME lines). */
  times: Record<string, string>
  /** After the world stopped its own: B's leftovers, the tunnels, B's root. */
  stop(): Promise<void>
}

/** A third machine: a folder (its HOME) and a machine id, no server. */
function hostMachine(root: string, name: string): Machine {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const idFile = path.join(dir, 'machine-id')
  fs.writeFileSync(idFile, `machine-${name}\n`)
  // Where its sessions work.
  fs.mkdirSync(path.join(dir, 'work'), { recursive: true })
  return { id: `machine-${name}`, dir, idFile, home: path.join(dir, 'home'), standbyDir: path.join(dir, 'standby'), port: 0, env: { HOME: dir } }
}

/**
 * Where a machine's servers run its session daemon (experiment `in_process_daemon`): 'default' leaves
 * the setting out of the config (on by default), 'off' pins it false (the daemon program of its own).
 */
export type InProcessDaemonSetting = 'default' | 'off'

/** The setting as a run prints it on every result: "in_process_daemon=true (default)" or "in_process_daemon=false". */
export function inProcessDaemonLabel(setting: InProcessDaemonSetting): string {
  return setting === 'off' ? 'in_process_daemon=false' : 'in_process_daemon=true (default)'
}

/** The door port a machine's daemon on this computer publishes now (daemon.port): it moves when a server takes the daemon in process, or a standby takes it again. */
export function localDaemonPort(d: MachineDaemon): () => number {
  return () => {
    try {
      const port = Number(fs.readFileSync(path.join(d.dir, 'daemon.port'), 'utf8').trim())
      if (Number.isInteger(port) && port > 0) return port
    } catch { /* none published now */ }
    return d.port
  }
}

export interface WorldOptions {
  portA: number; portB: number; log?: (s: string) => void; inProcessDaemon?: InProcessDaemonSetting
  /** Rehearsal diagnostics: log every git on a machine's home here (git-watch.ts; the machines on this computer only). */
  gitWatch?: string
}

/** Rehearsal (a): B on this computer, a folder beside A's. */
export async function makeRemoteWorld(root: string, opts: WorldOptions): Promise<RemoteWorld> {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const b = makeMachine(path.join(root, 'machines'), 'b', opts.portB)
  const place: BPlacement = {
    kind: 'one-box', label: 'this computer', wayC: true, b, io: LOCAL,
    basePath: process.env.PATH ?? '', envExtra: {},
    certOnB: async (cert) => cert.certFile,
    routeHomeOnB: (id) => path.join(root, 'machines', id.replace(/^machine-/, '')),
    routeHomeOfB: b.dir,
    walnut: [process.execPath, path.join(REPO, 'src', 'cli.ts')],
    forward: async () => {}, unforward: async () => {}, reverse: async () => {},
    daemonPort: localDaemonPort,
    times: {},
    stop: async () => {},
  }
  return buildRemoteWorld(root, opts, place)
}

/** The world around machine B's placement: A, H, the companion, every link and the config, here. */
export async function buildRemoteWorld(root: string, opts: WorldOptions, place: BPlacement): Promise<RemoteWorld> {
  const inProcessDaemon = opts.inProcessDaemon ?? 'default'
  const log = opts.log ?? (() => {})
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const cert = makeLoopbackCert(path.join(root, 'tls'))
  // Every process started from here (the servers, the jobs, the commands) trusts the loopback certificate, nothing else changes.
  process.env.NODE_EXTRA_CA_CERTS = cert.certFile
  const certB = await place.certOnB(cert)
  const machinesDir = path.join(root, 'machines')
  const a = makeMachine(machinesDir, 'a', opts.portA)
  const b = place.b
  const h = hostMachine(machinesDir, 'h')
  const ioOf = (m: Machine): MachineIO => (m === b ? place.io : LOCAL)
  const stops: Array<() => Promise<void>> = []
  // What a start that fails half way leaves running, ended before its error goes on (the world's stop does it once built).
  const undo: Array<() => Promise<unknown>> = []
  try {
    log('companion starting')
    const companion = await startCloudBoxReplica(path.join(root, 'companion'), undefined, { env: { WALNUT_CAPABILITIES: 'bridge-door,witness-door' } })
    undo.push(() => companion.stop())
    const machines = { a, b, h }
    const daemons = {} as RemoteWorld['daemons']
    // Before any daemon starts: the shim sits in each local machine's stub bin, first on the PATH of everything it runs.
    let stopWatch = () => {}
    if (opts.gitWatch) {
      const local = (Object.values(machines) as Machine[]).filter((m) => ioOf(m) === LOCAL)
      const { real } = installGitWatch({ log: opts.gitWatch, machines: machinesDir, binDirs: local.map((m) => path.join(m.dir, 'bin')) })
      stopWatch = watchEmptyTree({ log: opts.gitWatch, machines: machinesDir })
      log(`git watch: every git on a machine home logged to ${opts.gitWatch} (real git ${real})`)
    }
    for (const [k, m] of Object.entries(machines) as Array<['a' | 'b' | 'h', Machine]>) {
      const io = ioOf(m)
      const bin = path.join(m.dir, 'bin')
      // A walnut program named by a word (rehearsal (b)): found through each machine HOME's profile.
      await io.op('writeBin', bin, place.walnut.length === 1 && !path.isAbsolute(place.walnut[0]!) ? { profileHome: m.dir } : {})
      const dir = path.join(m.dir, 'daemon')
      // The built standalone twin: the very daemon this machine's server adopts as its own (same build).
      // It dials the companion's bridge through w-k's TLS front: it trusts the loopback certificate.
      const d = await io.op('startDaemon', { dir, home: m.dir, bin, env: { NODE_EXTRA_CA_CERTS: m === b ? certB : cert.certFile, ...(m === b ? place.envExtra : {}) } })
      daemons[k] = { dir, bin, handle: d.handle, pid: d.pid, port: d.port }
      log(`daemon ${m.id} on ${d.port} (${io.where})`)
      stops.push(async () => { await io.op('stopKept', d.handle).catch(() => {}) })
      undo.push(stops.at(-1)!)
      if (m === b) await place.forward(d.port)
    }
    const portOf = (k: 'a' | 'b' | 'h') => (k === 'b' ? place.daemonPort(daemons.b) : localDaemonPort(daemons[k]))
    const proxy = (port: () => number) => startSilentLinkProxy(port)
    let replicaPortB = 0
    const wmB: WitnessMachine | null = place.wayC ? await startWitnessMachine({ host: 'machine-b', root: path.join(b.dir, 'leader-witness'), walnutId: null }) : null
    if (wmB) undo.push(() => wmB.close())
    // Without way c, a setup-only link to w-b's machine (endSetupLink), the witness's record root on B.
    let setupB: { handle: string; port: number } | null = null
    let setupTarget = 0
    if (!place.wayC) {
      setupB = await place.io.op('startSetupWitness', { host: 'machine-b', root: path.join(b.dir, 'leader-witness') }) as { handle: string; port: number }
      const h = setupB.handle
      undo.push(async () => { await place.io.op('stopKept', h).catch(() => {}) })
      await place.forward(setupB.port)
      setupTarget = setupB.port
    }
    // A link to a machine's daemon dials the port that daemon publishes now, as a leader's tunnel does
    // (it reads daemon.port on the host at each connect): with the daemon in a server's process the port
    // moves each time a process takes the runtime (the server's boot, the standby after a switch).
    const links: RemoteWorld['links'] = {
      copy: await proxy(portOf('b')), aToH: await proxy(portOf('h')),
      bToA: await proxy(portOf('a')), bToH: await proxy(portOf('h')),
      doorA: await proxy(() => a.port), doorB: await proxy(() => replicaPortB), doorK: await proxy(() => companion.port),
      aToBService: wmB ? await proxy(() => wmB.port) : setupB ? await proxy(() => setupTarget) : null,
    }
    undo.push(() => Promise.all(Object.values(links).map((p) => p?.close())))
    const fronts = { a: await startTlsFront(cert, () => links.doorA.port), b: await startTlsFront(cert, () => links.doorB.port), k: await startTlsFront(cert, () => links.doorK.port) }
    undo.push(() => Promise.all(Object.values(fronts).map((f) => f.close())))
    // What B dials on this computer, at the same port on B: its links to A's and H's daemons, every door (B is a
    // client of all three witnesses), the companion's git, and A's door for hosts. What this computer dials on B:
    // B's door for hosts (and its API), its daemon (above, followed as it moves) and its host service (startServiceB).
    for (const p of [links.bToA.port, links.bToH.port, links.doorK.port, fronts.a.port, fronts.b.port, fronts.k.port, a.port]) await place.reverse(p)
    await place.forward(b.port)
    const door = (f: TlsFront) => `https://127.0.0.1:${f.port}${WITNESS_DOOR_PATH}`
    const keyOf = (m: Machine): 'a' | 'b' | 'h' => (m === a ? 'a' : m === b ? 'b' : 'h')
    // A route's probe (the host server manager's free ports) runs where the server runs, with a stand-in HOME there.
    const routeFromA = (m: Machine, p: SilentLinkProxy) => ({ port: p.port, home: m === b ? place.routeHomeOfB : m.dir, path: `${daemons[keyOf(m)].bin}${path.delimiter}${process.env.PATH ?? ''}` })
    // On one computer the probe takes that host's own bin (as before (b)); on B, B's, the only one there.
    const routeFromB = (m: Machine, p: SilentLinkProxy) => ({ port: p.port, home: place.routeHomeOnB(m.id), path: `${place.kind === 'one-box' ? daemons[keyOf(m)].bin : daemons.b.bin}${path.delimiter}${place.basePath}` })
    const machineEnv = (m: Machine, k: 'a' | 'b', routes: Record<string, { port: number; home: string; path: string }>, extra: Record<string, string> = {}): Record<string, string> => ({
      ...m.env,
      PATH: `${daemons[k].bin}${path.delimiter}${k === 'b' ? place.basePath : process.env.PATH ?? ''}`,
      WALNUT_DAEMON_DIR: daemons[k].dir, WALNUT_STREAMS_DIR: path.join(daemons[k].dir, 'streams'), WALNUT_SPAWN_JOURNAL: path.join(daemons[k].dir, 'spawn-journal.jsonl'),
      WALNUT_LEGACY_STREAMS_DIR: path.join(daemons[k].dir, 'no-legacy'), WALNUT_HOST_SERVER_ROOT: path.join(m.dir, 'host-root'),
      WALNUT_CAPABILITIES: 'witness-door', WALNUT_LEADER_SWITCH_TEST_KNOBS: '1', NODE_EXTRA_CA_CERTS: k === 'b' ? certB : cert.certFile,
      WALNUT_DISABLE_SEARCH: '1', WALNUT_DISABLE_BACKGROUND_AI: '1', WALNUT_LOCAL_CLAUDE_PROBE: '0', WALNUT_NO_AUTO_UPDATE: '1',
      WALNUT_REHEARSAL_DAEMON_ROUTES: JSON.stringify(routes),
      // The config decides (below), never an inherited per-process override.
      WALNUT_IN_PROCESS_DAEMON: '',
      // In process, the runtime keeps its sessions at a stop as the production dir's does (a deploy, a switch
      // stop), and the next process adopts them; an isolated dir's would be ended with it (daemon-standalone.ts
      // shouldReapOnExit). A daemon program of its own outlives every server either way.
      ...(inProcessDaemon === 'off' ? {} : { WALNUT_DAEMON_PERSISTENT: '1' }),
      ...(k === 'b' ? place.envExtra : {}),
      ...windowEnv(), ...extra,
    })
    // Each machine's server runs from its own checkout (B's: the code staged on B).
    const server = async (x: Machine) => { const r = await ioOf(x).op('runtime'); return [r.bun, path.join(r.repo, 'scripts/leader-switch/machine-server.ts'), '--port', String(x.port), '--dev'] }
    a.start = await server(a)
    b.start = await server(b)
    a.env = machineEnv(a, 'a', { [b.id]: routeFromA(b, links.copy), [h.id]: routeFromA(h, links.aToH) }, links.aToBService ? { WALNUT_REHEARSAL_WITNESS_LINKS: JSON.stringify({ [b.id]: links.aToBService.port }) } : {})
    b.env = machineEnv(b, 'b', { [a.id]: routeFromB(a, links.bToA), [h.id]: routeFromB(h, links.bToH) })
    // Its door for hosts (the leader's /host-door, ws:// to loopback): the handover's host steps run only when the new leader names one.
    const m = (x: Machine) => ({ id: x.id, home: x.home, standby_dir: x.standbyDir, port: x.port, start_command: x.start, env: x.env, host_key: x.id, doors: [`ws://127.0.0.1:${x.port}/host-door`] })
    // Where a session on a leader's own daemon works (it becomes a session of the old machine as a host after a switch).
    fs.mkdirSync(path.join(a.dir, 'work'), { recursive: true })
    await place.io.op('mkdir', path.join(b.dir, 'work'))
    const cfg = {
      // The default leaves in_process_daemon out (on by default); 'off' pins the daemon program of its own.
      experimental: { switchable_leader: true, ...(inProcessDaemon === 'off' ? { in_process_daemon: false } : {}) },
      // The copy goes to B over A's link to B's daemon (the copy link kind daemon); B's program runs `standby receive` there.
      standby: { dir: b.standbyDir, host: b.id, walnut: place.walnut, interval_seconds: 5 },
      hosts: { [a.id]: { hostname: a.id }, [b.id]: { hostname: b.id }, [h.id]: { hostname: h.id } },
      cloud_bridge: { url: `wss://127.0.0.1:${fronts.k.port}/bridge` },
      leader_switch: {
        witnesses: [
          { id: 'w-a', machine: a.id, url: door(fronts.a) },
          { id: 'w-b', machine: b.id, host: b.id, url: door(fronts.b) },
          { id: 'w-k', url: door(fronts.k) },
        ],
        machines: [m(a), m(b)],
        back_window_hours: 24,
      },
    }
    fs.mkdirSync(a.home, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(a.home, 'config.yaml'), YAML.stringify(cfg))
    // The data remote goes to the companion through its link too (doorK, plain http as the companion serves git):
    // a cut of the companion cuts its git sync as well, as on a real machine.
    await seedPrimaryPairing(a.home, `127.0.0.1:${links.doorK.port}`, companion.tokens)
    const serviceB: { handle: string | null } = { handle: null }
    const all = Object.values(links).filter((p): p is SilentLinkProxy => !!p)
    // Read at each cut: the setup-only link leaves once it is closed (endSetupLink), so no cut or mend touches it.
    const ofMachine = { a: () => [links.copy, links.aToH, ...(links.aToBService ? [links.aToBService] : [])], b: () => [links.bToA, links.bToH] }
    const side = (x: Machine): MachineSide => {
      const call = (c: SideCall) => ioOf(x).op('side', x, c)
      return {
        startServer: (mode, ms) => call({ method: 'startServer', args: [mode, ms] }) as Promise<StartResult>,
        stopServer: (ms) => call({ method: 'stopServer', args: [ms] }) as Promise<{ wasRunning: boolean }>,
        startStandby: (ms) => call({ method: 'startStandby', args: [ms] }) as Promise<StartResult>,
        runningPid: async () => ((await call({ method: 'runningServer' })) as { pid: number } | null)?.pid ?? null,
        standbyPid: async () => ((await call({ method: 'standbyServer' })) as { pid: number } | null)?.pid ?? null,
      }
    }
    const api: RemoteWorld['api'] = async (x, method, urlPath, body, opId) => {
      const res = await fetch(`http://127.0.0.1:${x.port}${urlPath}`, {
        method,
        headers: { 'content-type': 'application/json', ...(opId ? { 'x-walnut-op-id': opId } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      })
      return { status: res.status, json: await res.json().catch(() => null), headers: res.headers }
    }
    const world: RemoteWorld = {
      root, kind: place.kind, label: place.label, wayC: place.wayC, a, b, h, daemons, companion, links, fronts,
      witnessRoot: { 'w-a': path.join(a.dir, 'leader-witness'), 'w-b': path.join(b.dir, 'leader-witness'), 'w-k': path.join(companion.box.home, '.local', 'state', 'open-walnut', 'leader-witness') },
      walnutId: '',
      times: place.times,
      io: ioOf,
      side,
      api,
      cli: (x, args, env = {}) => ioOf(x).op('cli', x.home, args, env),
      async byHand(x, label, timeoutMs = 120_000) {
        const io = ioOf(x)
        const r = await io.op('byHandStart', x, label)
        const logText = async () => (await io.op('text', r.log)) ?? ''
        const stop = async () => { await io.op('stopPid', r.pid, 30_000).catch(() => {}) }
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline && await io.op('alive', r.pid)) {
          const ok = await fetch(`http://127.0.0.1:${x.port}/api/leader/status`, { signal: AbortSignal.timeout(5_000) }).catch(() => null)
          if (ok) return { ok: true, pid: r.pid, log: r.log, logText, stop }
          await new Promise((res) => setTimeout(res, 250))
        }
        await stop()
        return { ok: false, log: r.log, logText, stop }
      },
      cutMachine(k, mode) { for (const p of ofMachine[k]()) p.setMode(mode) },
      witnessDown(id, down) {
        const mode = down ? 'drop-hold' : 'pass'
        if (id === 'w-a') links.doorA.setMode(mode)
        if (id === 'w-b') { links.doorB.setMode(mode); links.aToBService?.setMode(mode) }
        if (id === 'w-k') links.doorK.setMode(mode)
      },
      async startServiceB(walnutId) {
        world.walnutId = walnutId
        if (wmB) wmB.walnutId = walnutId
        if (setupB) await place.io.op('setSetupWitnessWalnut', setupB.handle, walnutId)
        const r = await place.io.op('startService', { base: path.join(b.dir, 'service'), machineDir: b.dir, machineId: b.id, walnutId, witness: 'w-b' })
        await place.forward(r.port)
        serviceB.handle = r.handle
        replicaPortB = r.port
      },
      async endSetupLink() {
        if (!setupB) return false
        const { handle, port } = setupB
        setupB = null
        // The proxy stays (closed with the world), so its port is never another's, and now dials a listener of this
        // process that closes every connection at once: A's reach to it fails at once and A's next way is tried. The
        // scenarios no longer see it (no cut or mend touches it). Then the tunnel to B and the door there go.
        const refuser = net.createServer((sock) => sock.destroy())
        await new Promise<void>((r) => refuser.listen(0, '127.0.0.1', () => r()))
        stops.push(() => new Promise<void>((r) => refuser.close(() => r())))
        setupTarget = (refuser.address() as net.AddressInfo).port
        links.aToBService = null
        await place.unforward(port)
        await place.io.op('stopKept', handle)
        return true
      },
      async stop() {
        stopWatch()
        await world.endSetupLink().catch(() => false)
        for (const x of [a, b]) await side(x).stopServer(10_000).catch(() => {})
        if (serviceB.handle) await place.io.op('stopKept', serviceB.handle).catch(() => {})
        await wmB?.close().catch(() => {})
        await Promise.all(Object.values(fronts).map((f) => f.close().catch(() => {})))
        await Promise.all(all.map((p) => p.close().catch(() => {})))
        for (const s of stops) await s()
        await companion.stop().catch(() => {})
        // What the daemons started outlives them (a host service the handover configured, a CLI): every process left whose HOME is a machine here.
        await stopLeftovers(machinesDir)
        await place.stop()
      },
    }
    return world
  } catch (err) {
    for (const u of undo.reverse()) await u().catch(() => {})
    await stopLeftovers(machinesDir).catch(() => {})
    await place.stop().catch(() => {})
    throw err
  }
}
