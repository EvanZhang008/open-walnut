/**
 * The standby of a handed-over home (src/core/leader/switch/handed-over.ts): it says who leads,
 * refuses every other request with `handed_over`, keeps its pid file beside the instance lock and
 * writes nothing in the home. Fake homes in a temp folder, an ephemeral port.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { confirmStandby, handedOverAtBoot, otherStandbyOf, readStandbyServer, serveHandedOver, standbyForRecord, waitForOtherStandby, type StandbyListener } from '../../../../src/core/leader/switch/handed-over.js'
import { standbyServerFile } from '../../../../src/core/leader/switch/machine-id.js'
import { writeMarker } from '../../../../src/core/leader/switch/records.js'
import { setUpMachineWitness } from '../../../../src/core/leader/switch/witness-route.js'
import { directWitnessCall } from '../../../../src/core/leader/switch/witness-direct.js'
import { WITNESS_DOOR_PATH, WITNESS_REQUEST_PATH } from '../../../../src/core/leader/switch/witness-wire.js'
import { proofSecret, sha256Hex } from '../../../../src/utils/hmac-proof.js'
import { blankEvidence } from '../../../helpers/witness-machines.js'

let root: string
let home: string
let env: NodeJS.ProcessEnv
let open: StandbyListener | null = null

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'handed-over-'))
  home = path.join(root, 'home')
  fs.mkdirSync(home)
  fs.writeFileSync(path.join(root, 'machine-id'), 'machine-a\n')
  env = { WALNUT_MACHINE_ID_FILE: path.join(root, 'machine-id') }
})

afterEach(async () => {
  await open?.close()
  open = null
  fs.rmSync(root, { recursive: true, force: true })
})

function listing(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); out.push(`${path.relative(dir, p)}:${e.isFile() ? fs.readFileSync(p, 'utf8') : ''}`); if (e.isDirectory()) walk(p) } }
  walk(dir)
  return out.sort()
}

/** A port free on loopback now. */
async function freePort(): Promise<number> {
  const probe = http.createServer()
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done))
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((done) => probe.close(() => done()))
  return port
}

const url = (l: StandbyListener, p: string) => {
  const a = l.server.address()
  return `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}${p}`
}

describe('the standby of a handed-over home', () => {
  it('a home without the marker has no standby', () => {
    expect(handedOverAtBoot({ home, env })).toBeNull()
  })

  it('says who leads, refuses everything else with handed_over, and writes nothing in the home', async () => {
    writeMarker(home, { switchId: 's1', to: 'machine-b', state: 'handed-over', handover: 4, commit: 5, at: new Date().toISOString() })
    const before = listing(home)
    const s = handedOverAtBoot({ home, env })!
    expect(s).toMatchObject({ machine: 'machine-a', leader: 'machine-b', switchId: 's1', message: 'this machine handed the leader to machine-b (switch s1)' })
    open = await serveHandedOver(s, { port: 0, host: '127.0.0.1', env })
    const st = await (await fetch(url(open, '/api/leader/status'))).json()
    // No leader_switch section in this home's config: the marker names the leader, no witness is read.
    expect(st).toMatchObject({ standby: true, leader: 'machine-b', switchId: 's1', machine: 'machine-a', permit: { state: 'standby', mayAct: false } })
    // No session runtime reader given: the status names none.
    expect(st).not.toHaveProperty('sessionRuntime')
    // What the Mac app checks before it attaches (desktop/main.swift): a 200 on / and on /api/config.
    const page = await fetch(url(open, '/'))
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('This machine handed the leader to machine-b (switch s1).')
    for (const p of ['/api/health', '/api/config']) {
      const r = await fetch(url(open, p))
      expect(r.status, p).toBe(200)
      expect(await r.json()).toEqual({ standby: true, leader: 'machine-b', leaderDoors: [], switchId: 's1', message: 'this machine handed the leader to machine-b (switch s1)' })
    }
    // Concurrent status reads share one read of the witnesses and all answer.
    const many = await Promise.all(Array.from({ length: 5 }, () => fetch(url(open!, '/api/leader/status')).then((r) => r.status)))
    expect(many).toEqual([200, 200, 200, 200, 200])
    for (const [method, p] of [['POST', '/api/tasks'], ['GET', '/api/tasks'], ['PUT', '/api/notes-v2/content/a.md'], ['POST', '/api/config'], ['DELETE', '/']] as const) {
      const r = await fetch(url(open, p), { method, ...(method === 'GET' ? {} : { body: '{"x":1}', headers: { 'content-type': 'application/json' } }) })
      expect(r.status, `${method} ${p}`).toBe(409)
      expect(await r.json()).toEqual({ error: 'this machine handed the leader to machine-b (switch s1)', code: 'handed_over', leader: 'machine-b', leaderDoors: [], switchId: 's1' })
    }
    // Its pid file is outside the home, and the switch's side finds it there.
    const file = standbyServerFile(home, env)
    expect(file.startsWith(home)).toBe(false)
    const sb = readStandbyServer(home, env)!
    expect(sb).toMatchObject({ pid: process.pid })
    // Its port vouches for its pid before anything signals it; a file naming another pid is not believed.
    expect(await confirmStandby(sb)).toBe(true)
    expect(await confirmStandby({ ...sb, pid: sb.pid + 1 })).toBe(false)
    expect(listing(home)).toEqual(before)
    await open.close()
    open = null
    expect(fs.existsSync(file)).toBe(false)
    expect(readStandbyServer(home, env)).toBeNull()
    expect(listing(home)).toEqual(before)
  })

  it('a second standby of the same home, while one runs, starts nothing and says why', async () => {
    writeMarker(home, { switchId: 's1', to: 'machine-b', state: 'handed-over', commit: 5, at: new Date().toISOString() })
    // The one that runs: another live process (this test's parent) whose port vouches for its pid.
    const other = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ standby: true, pid: process.ppid })) })
    await new Promise<void>((done) => other.listen(0, '127.0.0.1', done))
    try {
      const port = (other.address() as { port: number }).port
      const file = standbyServerFile(home, env)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, port, home }))
      await expect(serveHandedOver(handedOverAtBoot({ home, env })!, { port: 0, host: '127.0.0.1', env })).rejects.toThrow(/a standby of this home already runs \(pid \d+, port \d+\)/)
      // Its file is the running one's, untouched.
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).pid).toBe(process.ppid)
    } finally {
      await new Promise<void>((done) => other.close(() => done()))
    }
  })

  it('its status names the session runtime it holds, read at each request (web/standby-service.ts)', async () => {
    writeMarker(home, { switchId: 's1', to: 'machine-b', state: 'handed-over', commit: 5, at: new Date().toISOString() })
    let runtime: unknown = null
    open = await serveHandedOver(handedOverAtBoot({ home, env })!, { port: 0, host: '127.0.0.1', env, sessionRuntime: () => runtime })
    expect((await (await fetch(url(open, '/api/leader/status'))).json()).sessionRuntime).toBeNull()
    runtime = { held: 'in-process', dir: '/tmp/d' }
    expect((await (await fetch(url(open, '/api/leader/status'))).json()).sessionRuntime).toEqual({ held: 'in-process', dir: '/tmp/d' })
    runtime = { held: false, why: 'declined' }
    expect((await (await fetch(url(open, '/api/leader/status'))).json()).sessionRuntime).toEqual({ held: false, why: 'declined' })
  })

  it('started at the stop (marker switching), it says the commit once the marker says it: the message, its 409 and the new leader\'s doors', async () => {
    writeMarker(home, { switchId: 's1', to: 'machine-b', state: 'switching', handover: 4, at: new Date().toISOString() })
    open = await serveHandedOver(handedOverAtBoot({ home, env })!, { port: 0, host: '127.0.0.1', env })
    expect((await (await fetch(url(open, '/api/leader/status'))).json()).message).toMatch(/is handing the leader to machine-b/)
    writeMarker(home, { switchId: 's1', to: 'machine-b', state: 'handed-over', handover: 4, commit: 5, leaderDoors: ['wss://b.example/host-door'], at: new Date().toISOString() })
    const deadline = Date.now() + 5_000
    let st: Record<string, unknown> = {}
    while (Date.now() < deadline) {
      st = await (await fetch(url(open, '/api/leader/status'))).json()
      if (st.message === 'this machine handed the leader to machine-b (switch s1)') break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(st).toMatchObject({ message: 'this machine handed the leader to machine-b (switch s1)', leaderDoors: ['wss://b.example/host-door'], handedOver: { state: 'handed-over', commit: 5 } })
    const w = await fetch(url(open, '/api/tasks'), { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    expect(await w.json()).toEqual({ error: 'this machine handed the leader to machine-b (switch s1)', code: 'handed_over', leader: 'machine-b', leaderDoors: ['wss://b.example/host-door'], switchId: 's1' })
  })

  it('a start beside a running standby waits, holding nothing, and ends once that standby is gone (a launcher does not loop)', async () => {
    writeMarker(home, { switchId: 's1', to: 'machine-b', state: 'handed-over', commit: 5, at: new Date().toISOString() })
    const other = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ standby: true, pid: process.ppid })) })
    await new Promise<void>((done) => other.listen(0, '127.0.0.1', done))
    try {
      const port = (other.address() as { port: number }).port
      const file = standbyServerFile(home, env)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, port, home }))
      const s = handedOverAtBoot({ home, env })!
      const running = await otherStandbyOf(home, env)
      expect(running).toMatchObject({ pid: process.ppid, port })
      const before = listing(home)
      const wait = waitForOtherStandby(s, running!, { env, lookMs: 20 })
      expect(wait.line).toMatch(/a standby of this home already runs \(pid \d+, port \d+\).*It takes no port/)
      expect(wait.server.listening).toBe(false)
      let ended: string | null = null
      void wait.ended.then((l) => { ended = l })
      await new Promise((r) => setTimeout(r, 120))
      expect(ended).toBeNull()
      // The other standby stops (its pid file goes with it): this one ends, for its launcher's next start.
      fs.rmSync(file)
      await new Promise((r) => setTimeout(r, 120))
      expect(ended).toMatch(/is gone; this waiting process ends/)
      // It wrote nothing anywhere: no pid file of its own, nothing in the home.
      expect(fs.existsSync(file)).toBe(false)
      expect(listing(home)).toEqual(before)
      await wait.close()
    } finally {
      await new Promise<void>((done) => other.close(() => done()))
    }
  })

  it('a waiting start whose standby\'s pid file outlived it (a pid used again, its port no standby) ends at the port check', async () => {
    writeMarker(home, { switchId: 's1', to: 'machine-b', state: 'handed-over', commit: 5, at: new Date().toISOString() })
    const file = standbyServerFile(home, env)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, port: 1, home }))
    const s = handedOverAtBoot({ home, env })!
    const asked: number[] = []
    const wait = waitForOtherStandby(s, { pid: process.ppid, port: 1 }, { env, lookMs: 10, confirm: async (sb) => { asked.push(sb.port); return false } })
    try {
      const line = await Promise.race([wait.ended, new Promise<null>((r) => setTimeout(() => r(null), 2_000))])
      expect(line).toMatch(/is gone; this waiting process ends/)
      expect(asked).toEqual([1])
      expect(fs.existsSync(file)).toBe(true)
    } finally { await wait.close() }
  })

  it('a job dead after the commit (marker still switching), the new leader\'s console replica up on the port: the standby keeps the port and its runtime, and does not end', async () => {
    const { setMachineIdHomeForTest } = await import('../../../../src/core/machine-id.js')
    const { writeConsoleFile, writeHolder } = await import('../../../../src/core/handed-over-console.js')
    // The console files live under the account's state dir: this test's own.
    setMachineIdHomeForTest(root)
    try {
      writeMarker(home, { switchId: 's1', to: 'machine-b', state: 'switching', handover: 4, at: new Date().toISOString() })
      // The standby looks for the console on its own port: a fixed one, as a machine's is.
      const port = await freePort()
      open = await serveHandedOver(handedOverAtBoot({ home, env })!, { port, host: '127.0.0.1', env, lookMs: 20, answerWaitMs: 50, say: () => {} })
      // B committed and its replica on this machine waits for the console's port (as after-commit-seen leaves it).
      const walnutId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
      writeConsoleFile({ v: 1, walnutId, home, port, host: '127.0.0.1', switchId: 's1', to: 'machine-b', device: 'console-machine-a', token: 'f'.repeat(32), at: new Date().toISOString() })
      writeHolder(walnutId, { pid: process.pid, state: 'serving', port, host: '127.0.0.1', since: new Date().toISOString() })
      let ended: string | null = null
      void open.ended.then((l) => { ended = l })
      await new Promise((r) => setTimeout(r, 400))
      // Twenty looks later: still serving its port (a console stands only on 'handed-over'), still running.
      expect(ended).toBeNull()
      expect(open.server.listening).toBe(true)
      expect((await (await fetch(url(open, '/api/leader/status'))).json()).standby).toBe(true)
    } finally {
      setMachineIdHomeForTest(null)
    }
  })

  it('yielded to the console, it reads its own switch at `switching` as still standing: it does not end (and so keeps its runtime)', async () => {
    const { setMachineIdHomeForTest } = await import('../../../../src/core/machine-id.js')
    const { writeConsoleFile, writeHolder } = await import('../../../../src/core/handed-over-console.js')
    setMachineIdHomeForTest(root)
    const replica = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ instance: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' })) })
    try {
      writeMarker(home, { switchId: 's1', to: 'machine-b', state: 'handed-over', handover: 4, commit: 5, at: new Date().toISOString() })
      const port = await freePort()
      open = await serveHandedOver(handedOverAtBoot({ home, env })!, { port, host: '127.0.0.1', env, lookMs: 20, answerWaitMs: 60_000, say: () => {} })
      const walnutId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
      writeConsoleFile({ v: 1, walnutId, home, port, host: '127.0.0.1', switchId: 's1', to: 'machine-b', device: 'console-machine-a', token: 'f'.repeat(32), at: new Date().toISOString() })
      writeHolder(walnutId, { pid: process.pid, state: 'serving', port, host: '127.0.0.1', since: new Date().toISOString() })
      const deadline = Date.now() + 3_000
      while (open.server.listening && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
      expect(open.server.listening).toBe(false)
      // The replica takes the port (it answers as this Walnut there).
      await new Promise<void>((done) => replica.listen(port, '127.0.0.1', done))
      let ended: string | null = null
      void open.ended.then((l) => { ended = l })
      // The same switch's marker at `switching` (not a transition a switch makes; the rule the resume needs).
      writeMarker(home, { switchId: 's1', to: 'machine-b', state: 'switching', handover: 4, at: new Date().toISOString() })
      await new Promise((r) => setTimeout(r, 300))
      expect(ended).toBeNull()
    } finally {
      await new Promise<void>((done) => replica.close(() => done()))
      setMachineIdHomeForTest(null)
    }
  })

  it('a switch still under way says so', () => {
    writeMarker(home, { switchId: 's2', to: 'machine-b', state: 'switching', at: new Date().toISOString() })
    expect(handedOverAtBoot({ home, env })?.message).toMatch(/is handing the leader to machine-b \(switch s2\).*--resume/)
  })

  it('a torn marker still marks: a standby that names no leader', () => {
    fs.mkdirSync(path.join(home, 'local', 'leader-switch'), { recursive: true })
    fs.writeFileSync(path.join(home, 'local', 'leader-switch', 'handed-over.json'), '{"switchId": "s3", "to": "mach')
    expect(handedOverAtBoot({ home, env })).toMatchObject({ leader: null, message: expect.stringMatching(/cannot be read/) })
  })

  it('found through the witnesses (no marker): names the holder and its record', () => {
    const s = standbyForRecord({ home, env, leader: 'machine-b', why: 'the witnesses name machine machine-b as the holder (record 7)', record: { number: 7, kind: 'grant', holder: 'machine-b', by: 'machine-b' } as never })
    expect(s).toMatchObject({ leader: 'machine-b', switchId: null, record: { number: 7, holder: 'machine-b' }, message: 'machine machine-b leads (permit record 7): this machine does not' })
  })

  it('a pid file naming another home, or a process that is gone, is no standby', () => {
    const file = standbyServerFile(home, env)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port: 1, home: path.join(root, 'other') }))
    expect(readStandbyServer(home, env)).toBeNull()
    fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, port: 1, home }))
    expect(readStandbyServer(home, env)).toBeNull()
    fs.writeFileSync(file, JSON.stringify({ pid: 1, port: 1, home }))
    expect(readStandbyServer(home, env)).toBeNull()
  })
})

describe('the standby keeps this machine\'s witness door (N1 of review r2)', () => {
  const WALNUT = 'walnut-standby-door'
  const LIST = ['w-a', 'w-c', 'w-k']
  const challenge = (l: StandbyListener, witness: string) => fetch(url(l, `${WITNESS_DOOR_PATH}/challenge`), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, walnutId: WALNUT, witness, digest: sha256Hex('x'), cnonce: proofSecret() }),
  })
  afterEach(() => { delete process.env.WALNUT_CAPABILITIES })

  it('off (the default): its paths get the handed_over refusal as every other path', async () => {
    writeMarker(home, { switchId: 's1', to: 'machine-b', state: 'handed-over', handover: 4, commit: 5, at: new Date().toISOString() })
    open = await serveHandedOver(handedOverAtBoot({ home, env })!, { port: 0, host: '127.0.0.1', env })
    const r = await challenge(open, 'w-a')
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ code: 'handed_over' })
  })

  it('on: the witness this machine keeps answers a keyed caller, one it does not keep says so, and the home is unchanged', async () => {
    process.env.WALNUT_CAPABILITIES = 'witness-door'
    const key = proofSecret()
    // The witness record and key are this machine's state (beside its machine id), never in the home.
    expect((await setUpMachineWitness(path.join(root, 'leader-witness'), { v: 1, walnutId: WALNUT, witness: 'w-a', list: LIST, evidence: blankEvidence(LIST, 'w-a'), key })).status).toBe(200)
    writeMarker(home, { switchId: 's1', to: 'machine-b', state: 'handed-over', handover: 4, commit: 5, at: new Date().toISOString() })
    const before = listing(home)
    open = await serveHandedOver(handedOverAtBoot({ home, env })!, { port: 0, host: '127.0.0.1', env })
    const doorUrl = url(open, WITNESS_DOOR_PATH)
    const read = await new Promise<{ status: number; body: unknown } | null>((resolve) => {
      directWitnessCall()({ id: 'w-a', url: doorUrl, key }, WITNESS_REQUEST_PATH, { v: 1, walnutId: WALNUT, witness: 'w-a', request: { type: 'read' } }, resolve)
    })
    expect(read).toMatchObject({ status: 200, body: { ok: true, reply: { witness: 'w-a', re: 'read', list: LIST } } })
    const none = await challenge(open, 'w-c')
    expect(none.status).toBe(404)
    expect(await none.json()).toEqual({ ok: false, error: 'no_witness_here' })
    // A wrong key is no answer; every other path is still refused.
    const wrong = await new Promise<{ status: number } | null>((resolve) => {
      directWitnessCall()({ id: 'w-a', url: doorUrl, key: proofSecret() }, WITNESS_REQUEST_PATH, { v: 1, walnutId: WALNUT, witness: 'w-a', request: { type: 'read' } }, resolve)
    })
    expect(wrong?.status).toBe(403)
    expect((await fetch(url(open, '/api/tasks'), { method: 'POST', body: '{}' })).status).toBe(409)
    expect(listing(home)).toEqual(before)
  })
})
