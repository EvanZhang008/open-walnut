/**
 * The switch completes when the candidate has NO leader link (docs/reference/leader-switch.md, "How
 * a witness is reached"): every process is real. Two real Walnut servers A (the leader, which has
 * links) and B (the candidate, which has none), two host services' witness doors (real leader
 * doors on loopback, each serving its machine's records from disk: B's own and a third machine
 * C's), the real cloud companion (the repo's companion test cluster: a WALNUT_CLOUD_MODE replica
 * with the capability `witness-door` on) behind TLS on loopback, and the real `walnut leader
 * witnesses init` and `walnut leader switch` commands.
 *
 *   A reaches w-b and w-c over its links (way c) and w-k by its direct door (way b).
 *   B reaches w-b in its own state dir (way a) and w-k by its direct door (way b); w-c not at all.
 *
 * Red control first: with the companion out of reach the candidate-side preflight refuses, names
 * the missing witnesses, and changes nothing. Then the switch, and B renewing on w-b and w-k while
 * w-c never sees a record of B's. No :3456, no ~/.open-walnut, no real companion.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { makeWorld, type World } from '../../scripts/leader-switch/world.js'
import { checkOneLeader, Checks, seed, waitForBatch } from '../../scripts/leader-switch/rehearsal.js'
import { readSwitchState } from '../../src/core/leader/switch/flow.js'
import { readHomeSwitchConfig, type RemoteWitnessPlace } from '../../src/core/leader/switch/settings.js'
import { witnessDir } from '../../src/core/leader/switch/witness-route.js'
import { startCloudBoxReplica, type CloudBoxReplica } from '../helpers/cloud-box-replica.js'
import { loopbackCall, startWitnessMachine, type WitnessMachine } from '../helpers/witness-machines.js'
import { WITNESS_REQUEST_PATH } from '../../src/core/leader/switch/witness-wire.js'
import type { RemoteCallResult } from '../../src/core/leader/switch/witness-transport.js'
import { makeLoopbackCert, startTlsFront, type TlsFront } from '../helpers/loopback-tls.js'
import { proofSecret } from '../../src/utils/hmac-proof.js'

const root = fs.mkdtempSync(path.join(process.env.LEADER_SWITCH_KEEP === '1' ? path.resolve(import.meta.dirname, '../../.scratch') : os.tmpdir(), 'leader-switch-no-link-'))
let companion: CloudBoxReplica | null = null
let front: TlsFront | null = null
const hosts: WitnessMachine[] = []
let w: World
const port = 5150 + (process.pid % 20) * 4
const companionKey = proofSecret()

afterAll(async () => {
  for (const m of [w?.a, w?.b]) if (m) await w.side(m).stopServer(10_000).catch(() => {})
  await front?.close()
  await companion?.stop().catch(() => {})
  await Promise.all(hosts.map((h) => h.close()))
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
const recordAt = (rootDir: string, walnutId: string, id: string) => JSON.parse(fs.readFileSync(path.join(witnessDir(rootDir, walnutId, id), 'permit-record.json'), 'utf8')) as { held: { number: number; holder: string; kind: string } | null }

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

describe('a switch whose candidate has no leader link', () => {
  let walnutId = ''
  const rootB = () => path.join(w.b.dir, 'leader-witness')
  const rootC = () => path.join(root, 'world', 'c', 'leader-witness')

  beforeAll(async () => {
    const cert = makeLoopbackCert(path.join(root, 'tls'))
    // Every process started from here (the servers, the commands) trusts the loopback certificate, nothing else changes.
    process.env.NODE_EXTRA_CA_CERTS = cert.certFile
    companion = await startCloudBoxReplica(path.join(root, 'companion'), undefined, { env: { WALNUT_CAPABILITIES: 'witness-door' } })
    front = await startTlsFront(cert, () => companion!.port)
    w = makeWorld(path.join(root, 'world'), { portA: port, portB: port + 1 })
    hosts.push(await startWitnessMachine({ host: 'host-b', root: rootB(), walnutId: null }))
    hosts.push(await startWitnessMachine({ host: 'host-c', root: rootC(), walnutId: null }))
    const cfgFile = path.join(w.a.home, 'config.yaml')
    const cfg = YAML.parse(fs.readFileSync(cfgFile, 'utf8')) as Record<string, any>
    cfg.leader_switch.witnesses = [
      { id: 'w-b', machine: w.b.id, host: 'host-b' },
      { id: 'w-c', machine: 'machine-c', host: 'host-c' },
      // The companion's key is in the config before init (an operator's, as init would mint it): its witness is set up
      // first, on the Mac's lane, because a list is set up before its first lead (A is not paired with the companion here).
      { id: 'w-k', url: `https://127.0.0.1:${front.port}/leader-witness`, key: companionKey },
    ]
    // Only A has links (to the two hosts' services); B has none.
    const a = cfg.leader_switch.machines.find((m: { id: string }) => m.id === w.a.id)
    a.env = { ...a.env, WALNUT_REHEARSAL_WITNESS_LINKS: JSON.stringify({ 'host-b': hosts[0]!.port, 'host-c': hosts[1]!.port }) }
    fs.writeFileSync(cfgFile, YAML.stringify(cfg))
    Object.assign(w.a, { env: a.env })
  }, 300_000)

  it('init mints each witness its own key and sets them up before the first lead; A leads on them; the standby copy carries the keys', async () => {
    const started = await w.side(w.a).startServer('leader', 300_000)
    expect(started.ok, started.why).toBe(true)
    walnutId = (await (await import('../../src/core/device-store.js')).instanceIdAt(w.a.home))!
    expect(walnutId).toBeTruthy()
    for (const h of hosts) h.walnutId = walnutId
    // A waits: no witness is set up yet, so none answers.
    expect((await status(w.a))?.mayAct).toBe(false)
    // The companion's witness first, on the paired Mac's lane (its machine token), from nothing: the two hosts are reached
    // and answer that no witness is there (absent), the evidence its setup carries.
    const call = loopbackCall(Object.fromEntries(hosts.map((h) => [h.host, h])))
    for (const [id, host] of [['w-b', 'host-b'], ['w-c', 'host-c']] as const) {
      const r = await new Promise<RemoteCallResult | null>((resolve) => { call({ id, host }, WITNESS_REQUEST_PATH, { v: 1, walnutId, witness: id, request: { type: 'read' } }, resolve) })
      expect(r).toEqual({ status: 404, body: { ok: false, error: 'not_found' } })
    }
    const setup = await fetch(`http://127.0.0.1:${companion!.port}/bridge/witness-setup`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${companion!.tokens.primaryMachine}` },
      body: JSON.stringify({ v: 1, walnutId, witness: 'w-k', list: ['w-b', 'w-c', 'w-k'], evidence: [{ witness: 'w-b', seen: 'absent' }, { witness: 'w-c', seen: 'absent' }], key: companionKey }),
    })
    expect(setup.status).toBe(200)
    // Run on A, as a person there would: A's machine identity. A has not led, so its server sets the hosts' witnesses
    // up over its registered reach (the host-dialed door's stand-in), never a leader-describing link.
    const init = await w.cli(w.a.home, ['leader', 'witnesses', 'init'], w.a.env)
    expect(init.out).toMatch(/Minted a key for w-b, w-c \(/)
    expect(init.out).toMatch(/Witness w-b on host-b: set up/)
    expect(init.out).toMatch(/Witness w-c on host-c: set up/)
    expect(init.out).toMatch(/Witness w-k on https:\/\/127\.0\.0\.1:\d+\/leader-witness: already set up/)
    const settings = readHomeSwitchConfig(w.a.home).settings!
    const keys = Object.fromEntries((settings.witnesses as RemoteWitnessPlace[]).map((x) => [x.id, x.key]))
    for (const k of Object.values(keys)) expect(k).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set(Object.values(keys)).size).toBe(3)
    expect(keys['w-k']).toBe(companionKey)
    // No key in what the command printed.
    for (const k of Object.values(keys)) expect(init.out).not.toContain(k)
    // Each machine keeps its witness's key beside its record, 0600.
    for (const [r, id] of [[rootB(), 'w-b'], [rootC(), 'w-c']] as const) {
      const f = path.join(witnessDir(r, walnutId, id), 'witness-key')
      expect(fs.readFileSync(f, 'utf8').trim()).toBe(keys[id])
      expect(fs.statSync(f).mode & 0o777).toBe(0o600)
    }
    const leads = await until(async () => (await status(w.a))?.mayAct, 120_000)
    expect(leads, JSON.stringify(await status(w.a))).toBe(true)
    await seed(w, w.a, 4)
    await waitForBatch(w.b.standbyDir, Date.now(), 120_000)
    const copy = readHomeSwitchConfig(path.join(w.b.standbyDir, 'copy')).settings!
    expect(Object.fromEntries((copy.witnesses as RemoteWitnessPlace[]).map((x) => [x.id, x.key]))).toEqual(keys)
    // A's renews reach all three: over its links to w-b and w-c, by the door to w-k.
    expect(recordAt(rootB(), walnutId, 'w-b').held?.holder).toBe(w.a.id)
    expect(recordAt(rootC(), walnutId, 'w-c').held?.holder).toBe(w.a.id)
  }, 600_000)

  it('red control: with the companion out of reach the candidate reaches one of three, the preflight names what is missing and changes nothing', async () => {
    front!.setUp(false)
    try {
      const beforeA = files(w.a.home)
      const beforeSwitch = files(path.join(w.a.home, 'local', 'leader-switch'))
      const t0 = Date.now()
      const sw = await w.cli(w.a.home, ['leader', 'switch', '--to', w.b.id])
      const elapsed = Date.now() - t0
      expect(sw.code, sw.out).toBe(1)
      expect(sw.out).toMatch(/the new leader cannot reach a majority of the witnesses on its own: machine-b reaches 1 of 3 witnesses without a leader link \(w-b \(on this machine\)\)/)
      expect(sw.out).toMatch(/w-c: no way to it without a leader link \(it is kept by machine-c; reached only over the leader's link to host-c\)/)
      expect(sw.out).toMatch(/w-k: its door https:\/\/127\.0\.0\.1:\d+\/leader-witness did not answer/)
      // Nothing changed: no new home, no switch record, no marker; in A's home only what A's own running server writes meanwhile.
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
      const live = /^(local\/leader-switch\/(may-act|server-leader\.log)|logs\/|.*\.(sqlite|db)-(wal|shm)$|.*\.log$)/
      expect(diff.filter((p) => !quiet.has(p) && !live.test(p)), `changed by the refused switch: ${diff.join(', ')}; by A alone: ${[...quiet].join(', ')}`).toEqual([])
      expect((await status(w.a))?.mayAct).toBe(true)
    } finally {
      front!.setUp(true)
    }
  }, 300_000)

  it('the switch completes through ways a and b: B commits on w-b and w-k, and renews there with no record of its at w-c', async () => {
    await waitForBatch(w.b.standbyDir, Date.now(), 120_000)
    const sw = await w.cli(w.a.home, ['leader', 'switch', '--to', w.b.id])
    const st = readSwitchState(w.a.home)
    expect(sw.code, sw.out).toBe(0)
    expect(st?.step).toBe('done')
    expect((await status(w.b))?.mayAct).toBe(true)
    const c = new Checks()
    checkOneLeader(c, 'A -> B, no leader link', w.a, w.b, { stoppedAt: st?.stoppedAt })
    expect(c.all.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`)).toEqual([])
    // B keeps the permission over a and b for a few renews.
    const n0 = recordAt(rootB(), walnutId, 'w-b').held!.number
    await new Promise((r) => setTimeout(r, 35_000))
    expect((await status(w.b))?.mayAct).toBe(true)
    const atB = recordAt(rootB(), walnutId, 'w-b').held!
    expect(atB.holder).toBe(w.b.id)
    expect(atB.number).toBeGreaterThan(n0)
    // w-c holds at most the handover A wrote over its link: B never reached it.
    const atC = recordAt(rootC(), walnutId, 'w-c').held!
    expect(atC.number).toBeLessThanOrEqual(st!.handover!)
    expect(atC.kind === 'handover' || atC.holder === w.a.id).toBe(true)
  }, 600_000)
})
