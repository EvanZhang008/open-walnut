/**
 * The service role a switch asks for (service-role.ts, service-start-hook.ts) and the wait of a server a
 * launcher starts on a home under promotion (promotion-wait.ts). Fakes of the mode writer for the order
 * (record before mode); then the real writer (src/binary/service-mode.ts setServiceRole) on a scratch
 * install root, through the real start hooks (service-start-hooks.ts runServiceStartHooks): a kill between
 * the record and the mode, healed by the start hook, and the job's resume converges.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyServiceRole, hostLeadRefusal, readSwitchPointer, serviceLeadRefusalHere, serviceModeSetter, writeSwitchPointer, type ServiceRoleRequest } from '../../../../src/core/leader/switch/service-role.js'
import { leaderSwitchStartHook } from '../../../../src/core/leader/switch/service-start-hook.js'
import { readServiceMode, setServiceRole, writeServiceMode } from '../../../../src/binary/service-mode.js'
import { runServiceStartHooks, SERVICE_START_HOOKS, type ServiceStartContext } from '../../../../src/binary/service-start-hooks.js'
import { promotionSettled, promotionWaitAtBoot, waitForPromotion } from '../../../../src/core/leader/switch/promotion-wait.js'
import { removeSwitchClaim, writeSwitchClaim } from '../../../../src/core/leader/switch/ticket.js'
import { writePromoted } from '../../../../src/core/leader/switch/records.js'
import type { RoleStep } from '../../../../src/core/leader/switch/flow.js'

let base = ''
let env: NodeJS.ProcessEnv = {}
const savedRoot = process.env.WALNUT_DAEMON_STATE_DIR
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'service-role-'))
  env = { WALNUT_MACHINE_ID_FILE: path.join(base, 'machine', 'machine-id') }
  delete process.env.WALNUT_DAEMON_STATE_DIR
})
afterEach(() => {
  if (savedRoot === undefined) delete process.env.WALNUT_DAEMON_STATE_DIR
  else process.env.WALNUT_DAEMON_STATE_DIR = savedRoot
  fs.rmSync(base, { recursive: true, force: true })
})

/** The mode file, faked: what it holds, and every write. */
function fakeMode() {
  const f = { mode: null as { role: 'leader' | 'replica'; home: string } | null, writes: [] as ServiceRoleRequest[] }
  const set = async (r: ServiceRoleRequest) => {
    f.writes.push(r)
    const changed = f.mode?.role !== r.role || f.mode?.home !== r.home
    f.mode = { role: r.role, home: r.home }
    return { changed }
  }
  return { f, set }
}

/** A job's state on disk, as the jobs keep it (the record of the role goes in it). */
function stateFile(step = 'role'): { file: string; read: () => { step: string; handover?: number; serviceRole?: RoleStep }; write: (x: object) => void } {
  const file = path.join(base, `state-${step}.json`)
  fs.writeFileSync(file, JSON.stringify({ step, handover: 7 }))
  return { file, read: () => JSON.parse(fs.readFileSync(file, 'utf8')), write: (x) => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...x })) }
}

class Killed extends Error {}

describe('the service role, with a fake mode writer', () => {
  it('records the wanted role before it asks for the mode, then marks it set; again it asks nothing', async () => {
    const { f, set } = fakeMode()
    const st = stateFile()
    const seen: Array<[boolean | undefined, unknown]> = []
    const want = { role: 'leader' as const, home: '/b/home', walnutId: 'walnut-1' }
    const r = await applyServiceRole({ want, switchId: 'S1', set, record: (x) => { seen.push([x.set, f.mode]); st.write({ serviceRole: x }) } })
    expect(r).toMatchObject({ ...want, set: true })
    expect(seen).toEqual([[undefined, null], [true, { role: 'leader', home: '/b/home' }]])
    await applyServiceRole({ want, switchId: 'S1', current: r, set, record: () => {} })
    expect(f.writes).toHaveLength(1)
  })

  it('a refusal is recorded as not set, with why; nothing throws (after the commit nothing rolls back)', async () => {
    const st = stateFile()
    const r = await applyServiceRole({ want: { role: 'leader', home: '/b/home', walnutId: 'w' }, switchId: 'S3', set: async () => { throw new Error('not_service_owner: another Walnut') }, record: (x) => st.write({ serviceRole: x }) })
    expect(r).toMatchObject({ set: false, why: expect.stringMatching(/not_service_owner/) })
  })

  it('no Walnut service on this machine: the real setter says so and writes nothing', async () => {
    expect(await serviceModeSetter({ role: 'leader', home: base, walnutId: 'w', switchId: 'S' })).toEqual({ notSet: true, why: expect.stringMatching(/no service install root/) })
    expect(await serviceLeadRefusalHere()).toBeNull()
  })

  it('the leader switch\'s hook is among the service start hooks, and the pointer is read where the jobs write it', async () => {
    expect(await Promise.all(SERVICE_START_HOOKS.map((load) => load()))).toContain(leaderSwitchStartHook)
    writeSwitchPointer({ switchId: 'S4', side: 'target', stateFile: '/x' }, env)
    expect(readSwitchPointer(env)).toMatchObject({ switchId: 'S4', side: 'target', stateFile: '/x' })
  })
})

describe('the service role on a real mode file (scratch install root)', () => {
  const EXE = '/opt/walnut/versions/v1/walnut'
  const WALNUT = 'walnut-1'
  let root = ''
  let newLeaderHome = ''
  beforeEach(() => {
    root = path.join(base, 'install')
    newLeaderHome = path.join(base, 'b-home')
    fs.mkdirSync(path.join(root, 'launcher'), { recursive: true })
    fs.mkdirSync(path.join(root, 'host-server'), { recursive: true })
    fs.mkdirSync(newLeaderHome)
    fs.writeFileSync(path.join(root, 'launcher', 'state'), `current=${EXE}\ngood=${EXE}\nphase=committed\n`)
    // This machine follows the new leader once it is a replica: its follower spec for that Walnut.
    fs.writeFileSync(path.join(root, 'host-server', 'server-b1.json'), JSON.stringify({ spec: { home: newLeaderHome, walnutId: WALNUT } }))
    process.env.WALNUT_DAEMON_STATE_DIR = root
  })

  /** A start of the service: the real hooks runner, the real writer, with this test's pointer place. */
  const serviceStart = (log: string[] = []) => {
    const read = readServiceMode(root)
    const mode = 'mode' in read ? read.mode : null
    const ctx: ServiceStartContext = {
      installRoot: root, runtimeDir: path.join(base, 'run'), decision: 'serve',
      mode: mode ? { role: mode.role ?? 'replica', home: mode.home, exe: mode.exe } : null,
      setRole: (next) => setServiceRole(root, next),
      log: (_l, m) => { log.push(m) },
    }
    return runServiceStartHooks(ctx, [async () => (c: ServiceStartContext) => leaderSwitchStartHook(c, env)])
  }

  it('old leader after the hand-off: killed between the record and the mode, the next start sets the role, the resume converges', async () => {
    // It led here: its mode names its own data dir as leader.
    const oldHome = path.join(base, 'a-home')
    fs.mkdirSync(oldHome)
    writeServiceMode(root, { v: 1, home: oldHome, exe: EXE, role: 'leader', walnutId: WALNUT })
    const st = stateFile('done')
    writeSwitchPointer({ switchId: 'S5', side: 'source', stateFile: st.file }, env)
    const want = { role: 'replica' as const, home: newLeaderHome, walnutId: WALNUT }
    // The kill: the wanted role is in the record, the mode never written.
    await expect(applyServiceRole({ want, switchId: 'S5', set: async () => { throw new Killed() }, record: (x) => { if (x.set !== undefined) throw new Killed(); st.write({ serviceRole: x }) } })).rejects.toThrow(Killed)
    expect(st.read().serviceRole).toMatchObject({ ...want })
    expect((readServiceMode(root) as { mode: { role?: string } }).mode.role).toBe('leader')
    // The launcher starts the service: its hook asks for the recorded role.
    const log: string[] = []
    const ran = await serviceStart(log)
    expect(ran.changed).toBe(true)
    expect(readServiceMode(root)).toEqual({ mode: { v: 1, home: newLeaderHome, exe: EXE, walnutId: WALNUT } })
    expect(log.join('\n')).toMatch(/service role follows the switch record \(replica on/)
    // The job resumed: the real writer, nothing changes, recorded set.
    const r = await applyServiceRole({ want, switchId: 'S5', current: st.read().serviceRole, record: (x) => st.write({ serviceRole: x }) })
    expect(r).toMatchObject({ set: true })
    expect(st.read().serviceRole?.set).toBe(true)
    // Set: a later mode a person chose stays theirs at the next start.
    writeServiceMode(root, { v: 1, home: oldHome, exe: EXE, role: 'leader', walnutId: WALNUT })
    expect((await serviceStart()).changed).toBe(false)
    expect((readServiceMode(root) as { mode: { home: string } }).mode.home).toBe(oldHome)
  })

  it('new leader at its commit: the start gets the handover for this start only; after the commit the leader role on the promoted home', async () => {
    const st = stateFile('commit')
    writeSwitchPointer({ switchId: 'S6', side: 'target', stateFile: st.file }, env)
    expect((await serviceStart()).env).toEqual({ WALNUT_LEADER_SWITCH_COMMIT: '7' })
    st.write({ step: 'role' })
    const want = { role: 'leader' as const, home: newLeaderHome, walnutId: WALNUT }
    await expect(applyServiceRole({ want, switchId: 'S6', set: async () => { throw new Killed() }, record: (x) => { if (x.set !== undefined) throw new Killed(); st.write({ serviceRole: x }) } })).rejects.toThrow(Killed)
    const ran = await serviceStart()
    expect(ran).toMatchObject({ changed: true, env: {} })
    expect(readServiceMode(root)).toEqual({ mode: { v: 1, home: newLeaderHome, exe: EXE, role: 'leader', walnutId: WALNUT } })
    expect(await applyServiceRole({ want, switchId: 'S6', current: st.read().serviceRole, record: (x) => st.write({ serviceRole: x }) })).toMatchObject({ set: true })
  })

  it('another Walnut\'s service is refused by the writer: recorded not set, the mode unchanged', async () => {
    writeServiceMode(root, { v: 1, home: newLeaderHome, exe: EXE, role: 'leader', walnutId: 'walnut-other' })
    const st = stateFile()
    const r = await applyServiceRole({ want: { role: 'leader', home: newLeaderHome, walnutId: WALNUT }, switchId: 'S7', record: (x) => st.write({ serviceRole: x }) })
    expect(r).toMatchObject({ set: false, why: expect.stringMatching(/not_service_owner/) })
    expect((readServiceMode(root) as { mode: { walnutId: string } }).mode.walnutId).toBe('walnut-other')
  })

  it('before the commit: the launcher\'s good version must say it can lead', async () => {
    expect(await serviceLeadRefusalHere({ ask: async () => 'replica leader' })).toBeNull()
    expect(await serviceLeadRefusalHere({ ask: async () => 'replica' })).toMatch(/does not say it can lead \(it says "replica"\)/)
    expect(await serviceLeadRefusalHere({ ask: async () => null })).toMatch(/no answer/)
    fs.writeFileSync(path.join(root, 'launcher', 'state'), 'current=/x\n')
    expect(await serviceLeadRefusalHere({ ask: async () => 'leader' })).toMatch(/names no version its launcher goes back to/)
  })
})

describe('a target reached as a host must say it can lead', () => {
  it('both its running version and its launcher\'s good version, never guessed', () => {
    expect(hostLeadRefusal('box', { serviceRoles: ['replica', 'leader'], launcher: { goodRoles: ['replica', 'leader'] } })).toBeNull()
    expect(hostLeadRefusal('box', null)).toMatch(/not connected/)
    expect(hostLeadRefusal('box', { serviceRoles: ['replica'], launcher: { goodRoles: ['leader'] } })).toMatch(/running version does not say/)
    expect(hostLeadRefusal('box', { serviceRoles: ['leader'] })).toMatch(/launcher goes back to does not say/)
    expect(hostLeadRefusal('box', { serviceRoles: ['leader'], launcher: {} })).toMatch(/goodRoles: null/)
  })
})

describe('a launcher start during a promotion', () => {
  it('waits (no port, no file) while the claim holds, the switch\'s own starts do not, and it ends once settled', async () => {
    const home = path.join(base, 'home')
    fs.mkdirSync(home)
    expect(promotionWaitAtBoot({ home, env })).toBeNull()
    writeSwitchClaim(home, 'S5', env)
    expect(promotionWaitAtBoot({ home, env })).toMatchObject({ switchId: 'S5', why: expect.stringMatching(/making this home the new leader's/) })
    expect(promotionWaitAtBoot({ home, env: { ...env, WALNUT_LEADER_SWITCH_START: 'S5' } })).toBeNull()
    const before = fs.readdirSync(home)
    const w = waitForPromotion(promotionWaitAtBoot({ home, env })!, { env, lookMs: 20 })
    expect(w.server.listening).toBe(false)
    let ended = ''
    void w.ended.then((l) => { ended = l })
    await new Promise((r) => setTimeout(r, 80))
    expect(ended).toBe('')
    // The promotion's mark not yet led keeps it waiting after the claim went.
    writePromoted(home, { switchId: 'S5', state: 'promoted' })
    removeSwitchClaim(home, 'S5', env)
    expect(promotionSettled(home, env)).toBe(false)
    expect(promotionWaitAtBoot({ home, env })?.why).toMatch(/standby copy that switch S5 is making/)
    // A live server of the switch on the home keeps it waiting too.
    writePromoted(home, { switchId: 'S5', state: 'led' })
    fs.writeFileSync(path.join(home, 'server.lock.json'), JSON.stringify({ pid: process.pid }))
    expect(promotionSettled(home, env)).toBe(false)
    fs.rmSync(path.join(home, 'server.lock.json'))
    await new Promise((r) => setTimeout(r, 80))
    expect(ended).toMatch(/switch S5 settled/)
    expect(fs.readdirSync(home).sort()).toEqual([...before, 'local'].filter((x, i, a) => a.indexOf(x) === i).sort())
    await w.close()
  })
})
