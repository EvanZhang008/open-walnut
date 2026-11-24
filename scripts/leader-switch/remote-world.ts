/**
 * The cross-machine rehearsal's world (docs/reference/leader-switch.md, "Rehearsal (a)"), on one
 * computer: three "machines", each its own folder used as HOME, its own machine id, its own daemon
 * dir and its own REAL daemon (the built standalone twin, the one its server adopts as its own):
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
 *            its direct door; A reaches it over its link to B's host service (way c, a witness
 *            machine on B's state root)
 *   w-k      the companion: the repo's companion test cluster (a WALNUT_CLOUD_MODE replica with
 *            `witness-door` on), behind TLS on loopback. A and B are paired with it (bridge-local)
 *
 * Every link is a startSilentLinkProxy: A to B's, A to H's, B to A's and B to H's daemon; each door
 * (w-a, w-b, w-k: a door is one proxy, so its cut is that witness out of reach for every machine);
 * A to B's host service (way c). Each machine's daemon dials the companion through w-k's proxy.
 *
 * Nothing here reads or writes outside `root`: no ~/.open-walnut, no :3456, no real companion.
 */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import type { ChildProcess } from 'node:child_process'
import { makeWorld, REPO, type Machine, type World } from './world.js'
import { startHostDaemon, windowEnv, writeStubBin } from '../../tests/helpers/replica-cluster.js'
import { startSilentLinkProxy, type SilentLinkProxy } from '../../tests/helpers/silent-link-proxy.js'
import { makeLoopbackCert, startTlsFront, type TlsFront } from '../../tests/helpers/loopback-tls.js'
import { seedPrimaryPairing, startCloudBoxReplica, type CloudBoxReplica } from '../../tests/helpers/cloud-box-replica.js'
import { startHostReplicaDoor, startWitnessMachine, type WitnessMachine } from '../../tests/helpers/witness-machines.js'
import { WITNESS_DOOR_PATH } from '../../src/core/leader/switch/witness-wire.js'

export interface MachineDaemon { dir: string; port: number; proc: ChildProcess; bin: string }

export interface RemoteWorld extends World {
  h: Machine
  daemons: Record<'a' | 'b' | 'h', MachineDaemon>
  companion: CloudBoxReplica
  /** The links, each a proxy: `copy` is A to B's daemon (the copy link). */
  links: { copy: SilentLinkProxy; aToH: SilentLinkProxy; bToA: SilentLinkProxy; bToH: SilentLinkProxy; doorA: SilentLinkProxy; doorB: SilentLinkProxy; doorK: SilentLinkProxy; aToBService: SilentLinkProxy }
  /** The TLS fronts of the three doors. */
  fronts: { a: TlsFront; b: TlsFront; k: TlsFront }
  /** Machine B's service: its witness's direct door (a host replica) and A's link to it (way c). */
  serviceB: { door: { port: number; stop: () => Promise<void>; log: () => string } | null; link: WitnessMachine }
  /** The witness roots (each machine's state dir), by witness id. */
  witnessRoot: Record<'w-a' | 'w-b' | 'w-k', string>
  walnutId: string
  /** Every daemon link one machine's server dials (to the other machines' daemons, and A's to B's host service), cut or back. A door is one proxy for every machine: witnessDown. */
  cutMachine(m: 'a' | 'b', mode: 'drop-hold' | 'severed' | 'pass'): void
  /** One witness out of reach (its door and its link), and back. */
  witnessDown(id: 'w-a' | 'w-b' | 'w-k', down: boolean): void
  /** Start B's host replica once the Walnut id is known (after A's first boot). */
  startServiceB(walnutId: string): Promise<void>
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

export async function makeRemoteWorld(root: string, opts: { portA: number; portB: number; log?: (s: string) => void }): Promise<RemoteWorld> {
  const log = opts.log ?? (() => {})
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const cert = makeLoopbackCert(path.join(root, 'tls'))
  // Every process started from here (the servers, the jobs, the commands) trusts the loopback certificate, nothing else changes.
  process.env.NODE_EXTRA_CA_CERTS = cert.certFile
  const w = makeWorld(path.join(root, 'machines'), { portA: opts.portA, portB: opts.portB })
  const h = hostMachine(path.join(root, 'machines'), 'h')
  log('companion starting')
  const companion = await startCloudBoxReplica(path.join(root, 'companion'), undefined, { env: { WALNUT_CAPABILITIES: 'bridge-door,witness-door' } })
  const machines = { a: w.a, b: w.b, h }
  const daemons = {} as RemoteWorld['daemons']
  for (const [k, m] of Object.entries(machines) as Array<['a' | 'b' | 'h', Machine]>) {
    const bin = path.join(m.dir, 'bin')
    writeStubBin(bin)
    const dir = path.join(m.dir, 'daemon')
    // The built standalone twin: the very daemon this machine's server adopts as its own (same build).
    // It dials the companion's bridge through w-k's TLS front: it trusts the loopback certificate.
    const d = await startHostDaemon('standalone', dir, m.dir, bin, true, { env: { NODE_EXTRA_CA_CERTS: cert.certFile } })
    daemons[k] = { dir, port: d.port, proc: d.proc, bin }
    log(`daemon ${m.id} on ${d.port}`)
  }
  const proxy = (port: () => number) => startSilentLinkProxy(port)
  let replicaPortB = 0
  const wmB = await startWitnessMachine({ host: 'machine-b', root: path.join(w.b.dir, 'leader-witness'), walnutId: null })
  const links: RemoteWorld['links'] = {
    copy: await proxy(() => daemons.b.port), aToH: await proxy(() => daemons.h.port),
    bToA: await proxy(() => daemons.a.port), bToH: await proxy(() => daemons.h.port),
    doorA: await proxy(() => w.a.port), doorB: await proxy(() => replicaPortB), doorK: await proxy(() => companion.port),
    aToBService: await proxy(() => wmB.port),
  }
  const fronts = { a: await startTlsFront(cert, () => links.doorA.port), b: await startTlsFront(cert, () => links.doorB.port), k: await startTlsFront(cert, () => links.doorK.port) }
  const door = (f: TlsFront) => `https://127.0.0.1:${f.port}${WITNESS_DOOR_PATH}`
  const walnut = [process.execPath, path.join(REPO, 'src', 'cli.ts')]
  const route = (m: Machine, p: SilentLinkProxy) => ({ port: p.port, home: m.dir, path: `${daemons[m === w.a ? 'a' : m === w.b ? 'b' : 'h'].bin}${path.delimiter}${process.env.PATH ?? ''}` })
  const machineEnv = (m: Machine, k: 'a' | 'b', routes: Record<string, ReturnType<typeof route>>, extra: Record<string, string> = {}): Record<string, string> => ({
    ...m.env,
    PATH: `${daemons[k].bin}${path.delimiter}${process.env.PATH ?? ''}`,
    WALNUT_DAEMON_DIR: daemons[k].dir, WALNUT_STREAMS_DIR: path.join(daemons[k].dir, 'streams'), WALNUT_SPAWN_JOURNAL: path.join(daemons[k].dir, 'spawn-journal.jsonl'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(daemons[k].dir, 'no-legacy'), WALNUT_HOST_SERVER_ROOT: path.join(m.dir, 'host-root'),
    WALNUT_CAPABILITIES: 'witness-door', WALNUT_LEADER_SWITCH_TEST_KNOBS: '1', NODE_EXTRA_CA_CERTS: cert.certFile,
    WALNUT_DISABLE_SEARCH: '1', WALNUT_DISABLE_BACKGROUND_AI: '1', WALNUT_LOCAL_CLAUDE_PROBE: '0', WALNUT_NO_AUTO_UPDATE: '1',
    WALNUT_REHEARSAL_DAEMON_ROUTES: JSON.stringify(routes),
    ...windowEnv(), ...extra,
  })
  const server = (m: Machine) => [process.execPath, path.join(REPO, 'scripts/leader-switch/machine-server.ts'), '--port', String(m.port), '--dev']
  w.a.start = server(w.a)
  w.b.start = server(w.b)
  w.a.env = machineEnv(w.a, 'a', { 'machine-b': route(w.b, links.copy), 'machine-h': route(h, links.aToH) }, { WALNUT_REHEARSAL_WITNESS_LINKS: JSON.stringify({ 'machine-b': links.aToBService.port }) })
  w.b.env = machineEnv(w.b, 'b', { 'machine-a': route(w.a, links.bToA), 'machine-h': route(h, links.bToH) })
  // Its door for hosts (the leader's /host-door, ws:// to loopback): the handover's host steps run only when the new leader names one.
  const m = (x: Machine) => ({ id: x.id, home: x.home, standby_dir: x.standbyDir, port: x.port, start_command: x.start, env: x.env, host_key: x.id, doors: [`ws://127.0.0.1:${x.port}/host-door`] })
  // Where a session on a leader's own daemon works (it becomes a session of the old machine as a host after a switch).
  for (const x of [w.a, w.b]) fs.mkdirSync(path.join(x.dir, 'work'), { recursive: true })
  const cfg = {
    experimental: { switchable_leader: true },
    // The copy goes to B over A's link to B's daemon (the copy link kind daemon); B's program runs `standby receive` there.
    standby: { dir: w.b.standbyDir, host: w.b.id, walnut, interval_seconds: 5 },
    hosts: { [w.a.id]: { hostname: w.a.id }, [w.b.id]: { hostname: w.b.id }, [h.id]: { hostname: h.id } },
    cloud_bridge: { url: `wss://127.0.0.1:${fronts.k.port}/bridge` },
    leader_switch: {
      witnesses: [
        { id: 'w-a', machine: w.a.id, url: door(fronts.a) },
        { id: 'w-b', machine: w.b.id, host: w.b.id, url: door(fronts.b) },
        { id: 'w-k', url: door(fronts.k) },
      ],
      machines: [m(w.a), m(w.b)],
      back_window_hours: 24,
    },
  }
  fs.mkdirSync(w.a.home, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(w.a.home, 'config.yaml'), YAML.stringify(cfg))
  await seedPrimaryPairing(w.a.home, `127.0.0.1:${companion.port}`, companion.tokens)
  const serviceB: RemoteWorld['serviceB'] = { door: null, link: wmB }
  const all = Object.values(links)
  const ofMachine = { a: [links.copy, links.aToH, links.aToBService], b: [links.bToA, links.bToH] }
  const world: RemoteWorld = {
    ...w, h, daemons, companion, links, fronts, serviceB,
    witnessRoot: { 'w-a': path.join(w.a.dir, 'leader-witness'), 'w-b': path.join(w.b.dir, 'leader-witness'), 'w-k': path.join(companion.box.home, '.local', 'state', 'open-walnut', 'leader-witness') },
    walnutId: '',
    cutMachine(k, mode) { for (const p of ofMachine[k]) p.setMode(mode) },
    witnessDown(id, down) {
      const mode = down ? 'drop-hold' : 'pass'
      if (id === 'w-a') links.doorA.setMode(mode)
      if (id === 'w-b') { links.doorB.setMode(mode); links.aToBService.setMode(mode) }
      if (id === 'w-k') links.doorK.setMode(mode)
    },
    async startServiceB(walnutId) {
      world.walnutId = walnutId
      wmB.walnutId = walnutId
      const r = await startHostReplicaDoor({ base: path.join(w.b.dir, 'service'), machineDir: w.b.dir, machineId: w.b.id, walnutId, witness: 'w-b' })
      replicaPortB = r.port
      serviceB.door = r
    },
    async stop() {
      for (const x of [w.a, w.b]) await w.side(x).stopServer(10_000).catch(() => {})
      await serviceB.door?.stop().catch(() => {})
      await wmB.close().catch(() => {})
      await Promise.all(Object.values(fronts).map((f) => f.close().catch(() => {})))
      await Promise.all(all.map((p) => p.close().catch(() => {})))
      for (const d of Object.values(daemons)) {
        const pid = d.proc.pid
        if (!pid) continue
        try { process.kill(pid, 'SIGTERM') } catch { continue }
        const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
        for (let i = 0; i < 100 && alive(); i++) await new Promise((r) => setTimeout(r, 100))
        if (alive()) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
      }
      await companion.stop().catch(() => {})
    },
  }
  return world
}
