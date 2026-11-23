/**
 * The service role a switch asks for (service-role.ts) and the wait of a server a launcher starts on a
 * home under promotion (promotion-wait.ts), with fakes for the launcher's mode file: record before mode,
 * a kill between the two healed by the start hook's resume, and a launcher's start that waits and never
 * leads until the switch settled.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyServiceRole, readSwitchPointer, resumeServiceRole, setServiceRoleSetter, writeSwitchPointer, type ServiceRoleRequest } from '../../../../src/core/leader/switch/service-role.js'
import { promotionSettled, promotionWaitAtBoot, waitForPromotion } from '../../../../src/core/leader/switch/promotion-wait.js'
import { removeSwitchClaim, writeSwitchClaim } from '../../../../src/core/leader/switch/ticket.js'
import { writePromoted } from '../../../../src/core/leader/switch/records.js'
import type { RoleStep } from '../../../../src/core/leader/switch/flow.js'

let base = ''
let env: NodeJS.ProcessEnv = {}
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'service-role-'))
  env = { WALNUT_MACHINE_ID_FILE: path.join(base, 'machine', 'machine-id') }
})
afterEach(() => { setServiceRoleSetter(null); fs.rmSync(base, { recursive: true, force: true }) })

/** The launcher's mode file, faked: what it holds, and every write. */
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
function stateFile(): { file: string; read: () => { step: string; handover?: number; serviceRole?: RoleStep }; write: (x: object) => void } {
  const file = path.join(base, 'state.json')
  fs.writeFileSync(file, JSON.stringify({ step: 'role', handover: 7 }))
  return { file, read: () => JSON.parse(fs.readFileSync(file, 'utf8')), write: (x) => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...x })) }
}

describe('the service role', () => {
  it('records the wanted role before it asks for the mode, then marks it set', async () => {
    const { f, set } = fakeMode()
    const st = stateFile()
    const seen: Array<{ recorded?: RoleStep; modeAtRecord: unknown }> = []
    const r = await applyServiceRole({ want: { role: 'leader', home: '/b/home' }, switchId: 'S1', set, record: (x) => { seen.push({ recorded: x, modeAtRecord: f.mode }); st.write({ serviceRole: x }) } })
    expect(r).toMatchObject({ role: 'leader', home: '/b/home', set: true })
    // First record: no mode written yet. Second: written.
    expect(seen.map((x) => [x.recorded?.set, x.modeAtRecord])).toEqual([[undefined, null], [true, { role: 'leader', home: '/b/home' }]])
    expect(st.read().serviceRole?.set).toBe(true)
    // Again: the same role set already, nothing asked.
    await applyServiceRole({ want: { role: 'leader', home: '/b/home' }, switchId: 'S1', current: r, set, record: () => {} })
    expect(f.writes).toHaveLength(1)
  })

  it('killed between the record and the mode: the start hook asks again, and the job\'s resume converges', async () => {
    const { f, set } = fakeMode()
    const st = stateFile()
    writeSwitchPointer({ switchId: 'S2', side: 'source', stateFile: st.file }, env)
    // The kill: the wanted role is on disk, the mode never written (the process died in between).
    class Killed extends Error {}
    await expect(applyServiceRole({ want: { role: 'replica', home: '/a/standby' }, switchId: 'S2', set: async () => { throw new Killed() }, record: (x) => { if (x.set !== undefined) throw new Killed('died'); st.write({ serviceRole: x }) } })).rejects.toThrow(Killed)
    expect(st.read().serviceRole).toMatchObject({ role: 'replica', home: '/a/standby' })
    expect(st.read().serviceRole?.set).toBeUndefined()
    expect(f.mode).toBeNull()
    // The launcher starts the service: its hook reads only the local records and asks for the role.
    const lines: string[] = []
    const hook = await resumeServiceRole({ mode: f.mode, setRole: (m) => set({ ...m, switchId: 'S2' }), log: (_l, m) => lines.push(m), env })
    expect(f.mode).toEqual({ role: 'replica', home: '/a/standby' })
    expect(hook.note).toMatch(/service role replica/)
    expect(hook.env).toBeUndefined()
    // The job resumed after it: the same role again, set once more (idempotent), recorded set.
    const r = await applyServiceRole({ want: { role: 'replica', home: '/a/standby' }, switchId: 'S2', current: st.read().serviceRole, set, record: (x) => st.write({ serviceRole: x }) })
    expect(r.set).toBe(true)
    expect(f.mode).toEqual({ role: 'replica', home: '/a/standby' })
    expect(f.writes.every((w) => w.role === 'replica' && w.home === '/a/standby')).toBe(true)
    // A second start with the mode right asks nothing.
    const n = f.writes.length
    await resumeServiceRole({ mode: f.mode, setRole: (m) => set({ ...m, switchId: 'S2' }), log: () => {}, env })
    expect(f.writes).toHaveLength(n)
  })

  it('not wired: the step is recorded as not set, with why; nothing fails', async () => {
    const st = stateFile()
    const r = await applyServiceRole({ want: { role: 'leader', home: '/b/home' }, switchId: 'S3', record: (x) => st.write({ serviceRole: x }) })
    expect(r).toMatchObject({ set: false, why: expect.stringMatching(/no role setting yet/) })
  })

  it('a target job at its commit hands a launcher-started service the handover it may commit on', async () => {
    const st = stateFile()
    fs.writeFileSync(st.file, JSON.stringify({ step: 'commit', handover: 9 }))
    writeSwitchPointer({ switchId: 'S4', side: 'target', stateFile: st.file }, env)
    expect(readSwitchPointer(env)?.switchId).toBe('S4')
    expect(await resumeServiceRole({ mode: null, setRole: () => ({ changed: false }), log: () => {}, env })).toEqual({ env: { WALNUT_LEADER_SWITCH_COMMIT: '9' } })
    // No pointer, or a record it cannot read: nothing asked, a note at most.
    fs.rmSync(st.file)
    expect((await resumeServiceRole({ mode: null, setRole: () => { throw new Error('never') }, log: () => {}, env })).note).toMatch(/cannot be read/)
    expect(await resumeServiceRole({ mode: null, setRole: () => { throw new Error('never') }, log: () => {}, env: { WALNUT_MACHINE_ID_FILE: path.join(base, 'none', 'id') } })).toEqual({})
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
