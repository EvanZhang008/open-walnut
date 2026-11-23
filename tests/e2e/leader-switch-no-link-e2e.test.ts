/**
 * The switch completes when the candidate has NO leader link, on the lead's layout (docs/reference/
 * leader-switch.md, "How a witness is reached" and "A witness that joins later"): two dev boxes and the
 * companion keep the three witnesses, and every process is real.
 *
 *   A, the first leader, runs on dev box 1 and keeps w-a in its own state dir (way a); its service opens
 *     the direct door to it (capability `witness-door`, the same module the companion runs).
 *   Dev box 2 keeps w-c: its host service (a real leader door on loopback, way c, A's link to it) and its
 *     service's direct door (way b) over the same records.
 *   The companion (the repo's companion test cluster: a WALNUT_CLOUD_MODE replica with `witness-door` on)
 *     keeps w-k behind TLS on loopback; A is paired with it, so init sets w-k up on A's own bridge lane.
 *   B, the candidate, keeps no witness and has no link: it reaches all three by their doors only.
 *
 * The bootstrap, as an operator runs it: init while A waits sets w-a and w-k up from nothing (every
 * witness reached, w-c's door says it holds nothing), A leads on them, and init again while A leads adds
 * w-c through two list changes (the link opens once A leads). Red control: with the companion's and
 * dev box 2's doors down the candidate-side preflight refuses and changes nothing, while A keeps leading. Then the switch with dev box
 * 2 down, and B renewing on w-a and w-k. No :3456, no ~/.open-walnut, no real companion.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import express from 'express'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { makeWorld, type World } from '../../scripts/leader-switch/world.js'
import { checkOneLeader, Checks, seed, waitForBatch } from '../../scripts/leader-switch/rehearsal.js'
import { readSwitchState } from '../../src/core/leader/switch/flow.js'
import { readHomeSwitchConfig, type RemoteWitnessPlace } from '../../src/core/leader/switch/settings.js'
import { witnessDir } from '../../src/core/leader/switch/witness-route.js'
import { createWitnessDoorRouter } from '../../src/web/routes/witness-door.js'
import { WITNESS_DOOR_PATH } from '../../src/core/leader/switch/witness-wire.js'
import { seedPrimaryPairing, startCloudBoxReplica, type CloudBoxReplica } from '../helpers/cloud-box-replica.js'
import { startWitnessMachine, type WitnessMachine } from '../helpers/witness-machines.js'
import { makeLoopbackCert, startTlsFront, type TlsFront } from '../helpers/loopback-tls.js'

const root = fs.mkdtempSync(path.join(process.env.LEADER_SWITCH_KEEP === '1' ? path.resolve(import.meta.dirname, '../../.scratch') : os.tmpdir(), 'leader-switch-no-link-'))
let companion: CloudBoxReplica | null = null
const fronts: TlsFront[] = []
const servers: http.Server[] = []
let hostC: WitnessMachine | null = null
let w: World
const port = 5150 + (process.pid % 20) * 4

afterAll(async () => {
  for (const m of [w?.a, w?.b]) if (m) await w.side(m).stopServer(10_000).catch(() => {})
  await Promise.all(fronts.map((f) => f.close()))
  await Promise.all(servers.map((s) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()) })))
  await companion?.stop().catch(() => {})
  await hostC?.close()
  // LEADER_SWITCH_KEEP=1 keeps the folder (the servers' logs, the switch state) for a look after a failure.
  if (process.env.LEADER_SWITCH_KEEP === '1') { console.log(`kept ${root}`); return }
  const open = (p: string) => {
    try { fs.chmodSync(p, 0o700); if (fs.lstatSync(p).isDirectory()) for (const e of fs.readdirSync(p)) open(path.join(p, e)) } catch { /* gone */ }
  }
  open(root)
  fs.rmSync(root, { recursive: true, force: true })
}, 120_000)

/** Every file under `dir` with its sha256 (a missing dir: empty). */
function files(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (rel: string) => {
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(rel, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) out.set(p, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, p))).digest('hex'))
    }
  }
  walk('')
  return out
}
function changed(a: Map<string, string>, b: Map<string, string>): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort()
}
type Held = { number: number; holder: string; kind: string; list?: string[] } | null
const recordAt = (rootDir: string, walnutId: string, id: string): { held: Held } | null => {
  try { return JSON.parse(fs.readFileSync(path.join(witnessDir(rootDir, walnutId, id), 'permit-record.json'), 'utf8')) as { held: Held } } catch { return null }
}

async function status(m: World['a']): Promise<{ mayAct: boolean; state?: string } | null> {
  const r = await w.api(m, 'GET', '/api/leader/status').catch(() => null)
  return (r?.json as { permit?: { mayAct: boolean; state?: string } } | null)?.permit ?? null
}
async function until<T>(fn: () => Promise<T | null | false | undefined>, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null)
    if (v) return v as T
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

/** A dev box service's direct door over `rootDir` (createWitnessDoorRouter, as the service mounts it), behind TLS. */
async function serviceDoor(cert: ReturnType<typeof makeLoopbackCert>, rootDir: string): Promise<TlsFront> {
  const app = express()
  app.use(WITNESS_DOOR_PATH, createWitnessDoorRouter({ root: rootDir }))
  const server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  servers.push(server)
  const front = await startTlsFront(cert, () => (server.address() as net.AddressInfo).port)
  fronts.push(front)
  return front
}

describe('a switch whose candidate has no leader link, on two dev boxes and the companion', () => {
  let walnutId = ''
  let doorC: TlsFront
  let doorK: TlsFront
  const rootA = () => path.join(w.a.dir, 'leader-witness')
  const rootC = () => path.join(root, 'devbox-2', 'leader-witness')
  const rootK = () => path.join(companion!.box.home, '.local', 'state', 'open-walnut', 'leader-witness')
  /** Every witness up holds the same record of A's: a witness that was out of reach caught up with the renews. */
  const caughtUp = (ids: Array<['w-a' | 'w-c' | 'w-k', () => string]>) => until(async () => {
    const held = ids.map(([id, r]) => recordAt(r(), walnutId, id)?.held ?? null)
    return held.every((h) => h && h.holder === w.a.id && h.number === held[0]!.number) ? held[0] : null
  }, 90_000)
  /** Dev box 2 down or up: its host service and its door. */
  const devBox2 = (up: boolean) => { hostC!.setUp(up); doorC.setUp(up) }

  beforeAll(async () => {
    const cert = makeLoopbackCert(path.join(root, 'tls'))
    // Every process started from here (the servers, the commands) trusts the loopback certificate, nothing else changes.
    process.env.NODE_EXTRA_CA_CERTS = cert.certFile
    companion = await startCloudBoxReplica(path.join(root, 'companion'), undefined, { env: { WALNUT_CAPABILITIES: 'witness-door' } })
    doorK = await startTlsFront(cert, () => companion!.port)
    fronts.push(doorK)
    w = makeWorld(path.join(root, 'world'), { portA: port, portB: port + 1 })
    const doorA = await serviceDoor(cert, rootA())
    doorC = await serviceDoor(cert, rootC())
    hostC = await startWitnessMachine({ host: 'host-c', root: rootC(), walnutId: null })
    const cfgFile = path.join(w.a.home, 'config.yaml')
    const cfg = YAML.parse(fs.readFileSync(cfgFile, 'utf8')) as Record<string, any>
    const door = (f: TlsFront) => `https://127.0.0.1:${f.port}${WITNESS_DOOR_PATH}`
    // No keys: init mints them.
    cfg.leader_switch.witnesses = [
      { id: 'w-a', machine: w.a.id, url: door(doorA) },
      { id: 'w-c', machine: 'machine-c', host: 'host-c', url: door(doorC) },
      { id: 'w-k', url: door(doorK) },
    ]
    // A is paired with the companion, its bridge lane on the same origin as w-k's door (the setup's token goes nowhere else).
    cfg.cloud_bridge = { url: `wss://127.0.0.1:${doorK.port}/bridge` }
    // Only A has a link (to dev box 2's host service); B has none.
    const a = cfg.leader_switch.machines.find((m: { id: string }) => m.id === w.a.id)
    a.env = { ...a.env, WALNUT_REHEARSAL_WITNESS_LINKS: JSON.stringify({ 'host-c': hostC.port }) }
    fs.writeFileSync(cfgFile, YAML.stringify(cfg))
    Object.assign(w.a, { env: a.env })
    await seedPrimaryPairing(w.a.home, `127.0.0.1:${companion.port}`, companion.tokens)
  }, 300_000)

  it('init while A waits sets w-a and w-k up from nothing, A leads on them, and init again while A leads adds w-c by list changes', async () => {
    const started = await w.side(w.a).startServer('leader', 300_000)
    expect(started.ok, started.why).toBe(true)
    walnutId = (await (await import('../../src/core/device-store.js')).instanceIdAt(w.a.home))!
    expect(walnutId).toBeTruthy()
    hostC!.walnutId = walnutId
    expect((await status(w.a))?.mayAct).toBe(false)

    const first = await w.cli(w.a.home, ['leader', 'witnesses', 'init'], w.a.env)
    expect(first.out).toMatch(/Minted a key for w-a, w-c, w-k \(/)
    expect(first.out).toMatch(/Witness w-a on this machine: set up/)
    expect(first.out).toMatch(/Witness w-k on https:\/\/127\.0\.0\.1:\d+\/leader-witness: set up/)
    // w-c's door said it holds nothing (the evidence the other two carry), but its setup comes only over A's link, which opens once A leads.
    expect(first.out).toMatch(/Witness w-c on host-c: not set up \(no answer from host-c \(before this server leads it opens no link to a host/)
    expect(first.code).toBe(1)
    const settings = readHomeSwitchConfig(w.a.home).settings!
    const keys = Object.fromEntries((settings.witnesses as RemoteWitnessPlace[]).map((x) => [x.id, x.key]))
    for (const k of Object.values(keys)) expect(k).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(Object.values(keys)).size).toBe(3)
    for (const k of Object.values(keys)) expect(first.out).not.toContain(k)
    expect(recordAt(rootC(), walnutId, 'w-c')).toBeNull()

    expect(await until(async () => (await status(w.a))?.mayAct, 120_000), JSON.stringify(await status(w.a))).toBe(true)
    const second = await w.cli(w.a.home, ['leader', 'witnesses', 'init'], w.a.env)
    expect(second.out).toMatch(/Witness w-a on this machine: already set up/)
    expect(second.out).toMatch(/Witness w-c on host-c: joined \(set up as joining, added by a list change\)/)
    expect(second.out).toMatch(/Witness w-k on https:\/\/127\.0\.0\.1:\d+\/leader-witness: already set up/)
    expect(second.code, second.out).toBe(0)
    // Each machine keeps its witness's key beside its record, 0600; the companion's in its own machine state.
    const kDir = path.join(companion!.box.home, '.local', 'state', 'open-walnut', 'leader-witness', walnutId, 'w-k')
    for (const [dir, id] of [[witnessDir(rootA(), walnutId, 'w-a'), 'w-a'], [witnessDir(rootC(), walnutId, 'w-c'), 'w-c'], [kDir, 'w-k']] as const) {
      const f = path.join(dir, 'witness-key')
      expect(fs.readFileSync(f, 'utf8').trim()).toBe(keys[id])
      expect(fs.statSync(f).mode & 0o777).toBe(0o600)
    }
    // All three come up: A's renews reach w-c too, on the full list.
    const atC = await until(async () => { const h = recordAt(rootC(), walnutId, 'w-c')?.held; return h?.holder === w.a.id && h.kind !== 'members' ? h : null }, 60_000)
    expect(atC?.holder).toBe(w.a.id)
    expect(recordAt(rootA(), walnutId, 'w-a')?.held?.holder).toBe(w.a.id)
    await seed(w, w.a, 4)
    await waitForBatch(w.b.standbyDir, Date.now(), 120_000)
    const copy = readHomeSwitchConfig(path.join(w.b.standbyDir, 'copy')).settings!
    expect(Object.fromEntries((copy.witnesses as RemoteWitnessPlace[]).map((x) => [x.id, x.key]))).toEqual(keys)
  }, 600_000)

  it('red control: with the companion and dev box 2\'s door down the candidate reaches one of three (w-c only over A\'s link), the preflight names what is missing and changes nothing', async () => {
    // A keeps leading meanwhile, on w-a and its link to w-c: what B lacks is only what B itself reaches.
    doorK.setUp(false)
    doorC.setUp(false)
    try {
      const beforeA = files(w.a.home)
      const beforeSwitch = files(path.join(w.a.home, 'local', 'leader-switch'))
      const t0 = Date.now()
      const sw = await w.cli(w.a.home, ['leader', 'switch', '--to', w.b.id])
      const elapsed = Date.now() - t0
      expect(sw.code, sw.out).toBe(1)
      expect(sw.out).toMatch(/the new leader cannot reach a majority of the witnesses on its own: machine-b reaches 1 of 3 witnesses without a leader link \(w-a \(its direct door\)\)/)
      expect(sw.out).toMatch(/w-c: its door https:\/\/127\.0\.0\.1:\d+\/leader-witness did not answer/)
      expect(sw.out).toMatch(/w-k: its door https:\/\/127\.0\.0\.1:\d+\/leader-witness did not answer/)
      expect(fs.existsSync(w.b.home)).toBe(false)
      expect(readSwitchState(w.a.home)).toBeNull()
      // There only A's own server writes meanwhile: its permission log, and its log (LocalSide started it).
      const switchDiff = changed(beforeSwitch, files(path.join(w.a.home, 'local', 'leader-switch')))
      expect(switchDiff.filter((p) => !/^(may-act|server-leader\.log$)/.test(p)), switchDiff.join(', ')).toEqual([])
      // The control interval: what A's home changes by itself over as long, with no switch.
      const quiet0 = files(w.a.home)
      await new Promise((r) => setTimeout(r, elapsed + 1_000))
      const quiet = new Set(changed(quiet0, files(w.a.home)))
      const diff = changed(beforeA, files(w.a.home))
      const live = /^(local\/leader-switch\/(may-act|server-leader\.log)|local\/health-monitor\/|logs\/|cache\/|tmp\/|sync\/|\.git\/|.*\.(sqlite|db)-(wal|shm)$|.*\.log$)/
      expect(diff.filter((p) => !quiet.has(p) && !live.test(p)), `changed by the refused switch: ${diff.join(', ')}; by A alone: ${[...quiet].join(', ')}`).toEqual([])
      expect((await status(w.a))?.mayAct).toBe(true)
    } finally {
      doorK.setUp(true)
      doorC.setUp(true)
    }
    // w-k missed A's renews meanwhile: wait until it holds A's latest again (the next renew brings it).
    expect(await caughtUp([['w-a', rootA], ['w-c', rootC], ['w-k', rootK]])).not.toBeNull()
  }, 300_000)

  it('the switch completes with dev box 2 down: B commits on w-a and w-k by their doors, and renews there', async () => {
    await waitForBatch(w.b.standbyDir, Date.now(), 120_000)
    // Dev box 2 goes down: its host service (A's link to w-c) and its door.
    devBox2(false)
    const sw = await w.cli(w.a.home, ['leader', 'switch', '--to', w.b.id])
    const st = readSwitchState(w.a.home)
    const held = Object.fromEntries((['w-a', 'w-k'] as const).map((id) => [id, recordAt(id === 'w-a' ? rootA() : rootK(), walnutId, id)?.held ?? null]))
    expect(sw.code, `${sw.out}\nrecords: ${JSON.stringify(held)}`).toBe(0)
    expect(st?.step).toBe('done')
    expect((await status(w.b))?.mayAct).toBe(true)
    const c = new Checks()
    checkOneLeader(c, 'A -> B, no leader link, one witness down', w.a, w.b, { stoppedAt: st?.stoppedAt })
    expect(c.all.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`)).toEqual([])
    // B keeps the permission over the two doors: wait for its renews to move w-a's number on (no fixed wait).
    const n0 = recordAt(rootA(), walnutId, 'w-a')!.held!.number
    const renewed = await until(async () => { const h = recordAt(rootA(), walnutId, 'w-a')?.held; return h && h.holder === w.b.id && h.number >= n0 + 2 ? h : null }, 120_000)
    expect(renewed?.holder).toBe(w.b.id)
    expect((await status(w.b))?.mayAct).toBe(true)
    // w-c was down throughout: it holds A's last record, nothing of B's.
    const atC = recordAt(rootC(), walnutId, 'w-c')!.held!
    expect(atC.holder).toBe(w.a.id)
    expect(atC.number).toBeLessThan(st!.handover!)
    devBox2(true)
  }, 600_000)
})
