/**
 * A switch begun on the machine that will lead (docs/reference/leader-switch.md, "Running the command on either
 * machine"): the leader's side (leader-relay-door.ts beginForwarded, the trust rule through the real beginRefusal)
 * and the command's side (candidate-command.ts runCandidateSwitch), each against a fake of the other.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { DEFAULT_PERMIT_PARAMS } from '../../../../src/core/leader/permit/index.js'
import { _forgetForwardedBegins, beginForwarded, forwardedBeginOf, forwardedJob, type ForwardedBeginDeps } from '../../../../src/core/leader/switch/leader-relay-door.js'
import { beginRefusal } from '../../../../src/core/leader/switch/final-stop.js'
import { runCandidateSwitch, candidateStandbyDir, type LeaderLink } from '../../../../src/core/leader/switch/candidate-command.js'
import { writeSwitchFile, targetStateName, type CheckReport } from '../../../../src/core/leader/switch/ticket.js'
import { writeMarker } from '../../../../src/core/leader/switch/records.js'
import type { LeaderSwitchSettings } from '../../../../src/core/leader/switch/settings.js'
import type { StartedBy } from '../../../../src/core/leader/switch/flow.js'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fwd-begin-'))
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))
const sa = path.join(base, 'a', 'standby')
const sb = path.join(base, 'b', 'standby')
const settings: LeaderSwitchSettings = {
  witnesses: [{ id: 'w1', machine: 'machine-a' }, { id: 'w2', machine: 'machine-b' }, { id: 'w3', url: 'https://k/leader-witness', key: 'ab'.repeat(32) }],
  machines: [
    { id: 'machine-a', home: path.join(base, 'a', 'home'), standbyDir: sa, port: 4901 },
    { id: 'machine-b', home: path.join(base, 'b', 'home'), standbyDir: sb, port: 4902 },
    { id: 'machine-c', home: path.join(base, 'c', 'home'), standbyDir: path.join(base, 'c', 'standby'), port: 4903 },
  ],
  backWindowHours: 24,
  commitWindowMs: 300_000,
  stopWaitMs: 120_000,
  params: { ...DEFAULT_PERMIT_PARAMS },
} as LeaderSwitchSettings
for (const d of [sa, sb]) fs.mkdirSync(d, { recursive: true })

/** The leader machine-a, its copy going to machine-b's standby_dir (`standby`), its host links by key. */
function deps(o: { standby?: { dir?: string; host?: string }; links?: Record<string, string | null>; underWay?: ReturnType<ForwardedBeginDeps['underWay']>; leader?: boolean; settings?: LeaderSwitchSettings } = {}) {
  const recorded: Array<{ switchId: string; from: string; to: string; by: StartedBy }> = []
  const started: Array<{ switchId: string; to: string; forwardedBy: string }> = []
  let closed = 0
  const d: ForwardedBeginDeps = {
    leader: () => (o.leader === false ? null : { machine: 'machine-a' }),
    // The production rule (final-stop.ts), only the copy link is a fake.
    switchLink: async (to, me, { forwardedBy, forwardedHostKey }) => {
      const why = beginRefusal({ settings: o.settings ?? settings, me, to, standby: o.standby ?? { dir: sb }, forwardedBy, forwardedHostKey })
      return why ? { refused: why } : { settings, peer: { close: () => { closed++ } } as never }
    },
    underWay: () => o.underWay ?? null,
    record: (x) => { recorded.push(x) },
    startSourceJob: (x) => { started.push(x); return { log: path.join(base, 'source.log'), from: 0, pid: 4242, exit: new Promise(() => {}) } },
  }
  // Who a stream came from is the link's own (its key, its hello's machine id), as the DaemonConnection tells it.
  const links = o.links ?? { 'dev-b': 'machine-b', 'dev-c': 'machine-c' }
  const begin = (hostKey: string, body: unknown) => beginForwarded({ hostKey, machineId: links[hostKey] ?? null }, body, d)
  return { d, recorded, started, closed: () => closed, begin }
}

beforeEach(() => _forgetForwardedBegins())

describe('the leader takes a forwarded begin only from the machine it goes to', () => {
  it('a link whose machine id is not `to` is refused, and nothing is recorded or started', async () => {
    const f = deps()
    const r = await f.begin('dev-c', { to: 'machine-b', switchId: 'S-1' })
    expect(r.status).toBe(403)
    expect(r.json.why).toMatch(/taken only from the machine it goes to \(machine-b\), not from machine-c/)
    expect(f.recorded).toEqual([])
    expect(f.started).toEqual([])
  })

  const keyed = { ...settings, machines: settings.machines.map((m) => (m.id === 'machine-b' ? { ...m, hostKey: 'dev-b' } : m)) } as LeaderSwitchSettings

  it('taken by the first condition: the machine id the link\'s own hello said is `to` (no host_key needed)', async () => {
    const f = deps({ links: { 'host-of-b': 'machine-b' } })
    expect((await f.begin('host-of-b', { to: 'machine-b', switchId: 'S-2a' })).status).toBe(200)
    expect(f.started).toEqual([{ switchId: 'S-2a', to: 'machine-b', forwardedBy: 'machine-b' }])
  })

  it('taken by the second condition: the link is the leader\'s host whose key leader_switch.machines gives `to` (its hello says another id)', async () => {
    const f = deps({ links: { 'dev-b': 'f'.repeat(32) }, settings: keyed })
    expect((await f.begin('dev-b', { to: 'machine-b', switchId: 'S-2k' })).status).toBe(200)
    // Neither: the same link with no host_key for machine-b, and a hello id that is not machine-b.
    expect((await deps({ links: { 'dev-b': 'f'.repeat(32) } }).begin('dev-b', { to: 'machine-b', switchId: 'S-2n' })).json.why).toMatch(/not from f{32} \(host dev-b\)/)
    // A hello with no id at all, no host_key: refused by name.
    expect((await deps({ links: { 'dev-b': null } }).begin('dev-b', { to: 'machine-b', switchId: 'S-2' })).json.why).toMatch(/not from an unknown machine \(host dev-b\)/)
  })

  it('the source is the link alone: a body that claims to be `to` (or its host) over another host\'s link is refused', async () => {
    const f = deps({ settings: keyed })
    const claims = { to: 'machine-b', switchId: 'S-2b', from: 'machine-b', machine: 'machine-b', machineId: 'machine-b', hostKey: 'dev-b', host: 'dev-b', startedBy: { machine: 'machine-b', via: 'forwarded' } }
    const r = await f.begin('dev-c', claims)
    expect(r.status).toBe(403)
    expect(r.json.why).toMatch(/taken only from the machine it goes to \(machine-b\), not from machine-c \(host dev-c\)/)
    expect(f.recorded).toEqual([])
    expect(f.started).toEqual([])
  })

  it('a link from a host that is not `to`\'s (no machine of leader_switch.machines, or another one) is refused', async () => {
    // A host nobody lists, whose hello names a machine nobody lists.
    expect((await deps({ links: { stray: 'machine-z' }, settings: keyed }).begin('stray', { to: 'machine-b', switchId: 'S-2s' })).json.why).toMatch(/not from machine-z \(host stray\)/)
    // Another listed machine's host (machine-c), whatever it asks for machine-b.
    expect((await deps({ settings: keyed }).begin('dev-c', { to: 'machine-b', switchId: 'S-2c' })).json.why).toMatch(/not from machine-c \(host dev-c\)/)
  })

  it('`to` not listed in leader_switch.machines is refused (even from its own link)', async () => {
    const f = deps({ links: { 'dev-x': 'machine-x' } })
    const r = await f.begin('dev-x', { to: 'machine-x', switchId: 'S-3' })
    expect(r.status).toBe(403)
    expect(r.json.why).toMatch(/machine machine-x is not in leader_switch.machines/)
  })

  it('a machine that does not hold the standby target is refused (even from its own link)', async () => {
    const f = deps()
    const r = await f.begin('dev-c', { to: 'machine-c', switchId: 'S-4' })
    expect(r.status).toBe(403)
    expect(r.json.why).toMatch(/not to machine-c's standby_dir/)
    // And with no standby copy at all.
    expect((await deps({ standby: {} }).begin('dev-b', { to: 'machine-b', switchId: 'S-5' })).json.why).toMatch(/no standby copy/)
  })

  it('the right one: recorded as begun by that machine (forwarded), the source job started with its switch id, asked again answers the same', async () => {
    const f = deps()
    const r = await f.begin('dev-b', { to: 'machine-b', switchId: 'S-6' })
    expect(r).toEqual({ status: 200, json: { ok: true, switchId: 'S-6', leader: 'machine-a', startedBy: { machine: 'machine-b', via: 'forwarded' } } })
    expect(f.recorded).toEqual([{ switchId: 'S-6', from: 'machine-a', to: 'machine-b', by: { machine: 'machine-b', via: 'forwarded' } }])
    expect(f.started).toEqual([{ switchId: 'S-6', to: 'machine-b', forwardedBy: 'machine-b' }])
    expect(f.closed()).toBe(1)
    expect(forwardedBeginOf('S-6')?.by).toEqual({ machine: 'machine-b', via: 'forwarded' })
    const again = await f.begin('dev-b', { to: 'machine-b', switchId: 'S-6' })
    expect(again.json.again).toBe(true)
    expect(f.started).toHaveLength(1)
  })

  it('two begins at once: the second is refused while the first is between its checks and its job', async () => {
    let release!: () => void
    const f = deps()
    const slow = f.d.switchLink
    f.d.switchLink = async (...a) => { await new Promise<void>((r) => { release = r }); return slow(...a) }
    const first = f.begin('dev-b', { to: 'machine-b', switchId: 'S-10' })
    const second = await f.begin('dev-b', { to: 'machine-b', switchId: 'S-11' })
    expect(second).toMatchObject({ status: 409, json: { why: 'switch S-10 is being begun here' } })
    release()
    expect((await first).status).toBe(200)
    expect(f.started.map((x) => x.switchId)).toEqual(['S-10'])
    expect(f.recorded.map((x) => x.switchId)).toEqual(['S-10'])
  })

  it('a switch under way, a server that does not lead, or a bad switch id: refused', async () => {
    expect((await deps({ underWay: { id: 'S-0', to: 'machine-b', step: 'handover' } }).begin('dev-b', { to: 'machine-b', switchId: 'S-7' })).json.why).toMatch(/switch S-0 to machine-b is under way here/)
    expect((await deps({ leader: false }).begin('dev-b', { to: 'machine-b', switchId: 'S-8' })).status).toBe(409)
    expect((await deps().begin('dev-b', { to: 'machine-b', switchId: '../x' })).status).toBe(400)
  })

  it('the job route gives the started job\'s whole lines from an offset, and its step', async () => {
    const f = deps()
    fs.writeFileSync(path.join(base, 'source.log'), 'preflight\nhandover: checks passed\npartial')
    await f.begin('dev-b', { to: 'machine-b', switchId: 'S-9' })
    const r = forwardedJob('dev-b', 'S-9', 0, () => ({ step: 'handover' }))
    expect(r.json).toMatchObject({ ok: true, text: 'preflight\nhandover: checks passed\n', running: true, state: { step: 'handover', rollbackWhy: null } })
    expect(forwardedJob('dev-b', 'S-9', r.json.to as number, () => null).json.text).toBe('')
    expect(forwardedJob('dev-b', 'S-nope', 0, () => null).status).toBe(404)
    // Only to the link the begin came over: another host learns nothing, not even that the switch exists.
    expect(forwardedJob('dev-c', 'S-9', 0, () => ({ step: 'handover' }))).toEqual({ status: 404, json: { ok: false, why: 'this server began no switch S-9 for another machine' } })
  })
})

describe('the command run on the machine that will lead', () => {
  const machineFile = path.join(base, 'b', 'machine-id')
  fs.writeFileSync(machineFile, 'machine-b\n')
  const env = { ...process.env, WALNUT_MACHINE_ID_FILE: machineFile }
  const copy = path.join(sb, 'copy')
  fs.mkdirSync(copy, { recursive: true })
  fs.writeFileSync(path.join(copy, 'config.yaml'), YAML.stringify({
    experimental: { switchable_leader: true },
    leader_switch: { witnesses: settings.witnesses, machines: settings.machines.map((m) => ({ id: m.id, home: m.home, standby_dir: m.standbyDir, port: m.port })) },
  }))
  const okCheck = async (id: string): Promise<CheckReport> => ({ switchId: id, machine: 'machine-b', ok: true, problems: [], version: '1', at: '', reach: [{ id: 'w1', answered: true, held: { holder: 'machine-a' } }, { id: 'w2', answered: true, held: { holder: 'machine-a' } }, { id: 'w3', answered: false, held: null }] })
  const lines: string[] = []
  const run = (o: Partial<Parameters<typeof runCandidateSwitch>[0]>) => runCandidateSwitch({ standbyDir: sb, env, out: (l) => lines.push(l), check: okCheck, pollMs: 20, ...o })

  beforeEach(() => { lines.length = 0 })

  it('is found by `--to <this machine>` from its copy, or by --standby-dir', () => {
    expect(candidateStandbyDir({ home: copy, env, to: 'machine-b' })).toBe(sb)
    expect(candidateStandbyDir({ home: sb, env, to: 'machine-b' })).toBe(sb)
    expect(candidateStandbyDir({ home: copy, env, to: 'machine-a' })).toBeNull()
    expect(candidateStandbyDir({ home: '/nowhere', env, standbyDir: sb })).toBe(sb)
  })

  it('on this machine\'s own home that may lead (no handed-over marker) it is the leader\'s command, not the candidate\'s', () => {
    const own = settings.machines.find((m) => m.id === 'machine-b')!.home
    fs.mkdirSync(own, { recursive: true })
    fs.copyFileSync(path.join(copy, 'config.yaml'), path.join(own, 'config.yaml'))
    expect(candidateStandbyDir({ home: own, env, to: 'machine-b' })).toBeNull()
    // Handed over (an old leader's home after its switch): the candidate's, so it can switch back.
    writeMarker(own, { switchId: 'S-old', to: 'machine-a', state: 'handed-over', handover: 1, at: new Date().toISOString() })
    expect(candidateStandbyDir({ home: own, env, to: 'machine-b' })).toBe(sb)
  })

  it('with no link to the leader: refuses, naming the machine to run it on, and asks nothing of anyone', async () => {
    const r = await run({ link: { none: 'no relay socket' } })
    expect(r.code).toBe(1)
    expect(r.message).toMatch(/this machine has no link to the leader machine-a \(no relay socket\): run `walnut leader switch --to machine-b` on machine-a, the machine that leads/)
    expect(fs.readdirSync(sb).filter((n) => n === 'switch')).toEqual([])
  })

  it('with a production link and no relay socket here: the same refusal, by the socket it looked for', async () => {
    fs.writeFileSync(path.join(copy, 'auth.json'), JSON.stringify({ instanceId: 'f'.repeat(32), devices: [] }))
    const r = await run({ env: { ...env, WALNUT_DAEMON_DIR: path.join(base, 'no-daemon') } })
    expect(r.code).toBe(1)
    expect(r.message).toMatch(/no link to the leader machine-a \(no Walnut service .* \(no relay socket .*leader-relay\/[0-9a-f]{16}\.sock\)/)
  })

  it('a link that answers nothing, and a leader that refuses: refused with the reason, the begin sent once', async () => {
    const dead: LeaderLink = async () => { throw new Error('socket closed') }
    expect((await run({ link: dead })).message).toMatch(/host link did not reach the leader machine-a \(socket closed\): run `walnut leader switch --to machine-b` on machine-a/)
    const sent: unknown[] = []
    const no: LeaderLink = async (_m, route, body) => { sent.push([route, body]); return { status: 403, json: { ok: false, why: 'a switch begun from another machine is taken only from the machine it goes to', leader: 'machine-a' } } }
    const r = await run({ link: no })
    expect(r.code).toBe(1)
    expect(r.message).toMatch(/machine-a refused the switch: a switch begun from another machine/)
    expect(sent).toEqual([['/leader-switch/begin', { to: 'machine-b', switchId: expect.any(String) }]])
  })

  it('a check that fails refuses before any begin', async () => {
    let asked = 0
    const r = await run({ check: async (id) => ({ ...(await okCheck(id)), ok: false, problems: ['only 1 of 3 witnesses answered'] }), link: async () => { asked++; return { status: 200, json: {} } } })
    expect(r).toMatchObject({ code: 1, message: expect.stringMatching(/the check on machine-b: only 1 of 3 witnesses answered/) })
    expect(asked).toBe(0)
  })

  it('a begin taken: prints the leader\'s job, then follows its own target job to its end', async () => {
    let id = ''
    let polls = 0
    const link: LeaderLink = async (method, route, body) => {
      if (method === 'POST') { id = (body as { switchId: string }).switchId; return { status: 200, json: { ok: true, leader: 'machine-a' } } }
      polls++
      if (polls === 2) {
        // The ticket came and the target job ran here: its end state, as its job writes it.
        writeSwitchFile(sb, targetStateName(id), { id, from: 'machine-a', to: 'machine-b', step: 'done', log: [], standbyDir: sb, handover: 1, commitDeadline: '' })
      }
      if (polls >= 3) throw new Error('the leader stopped')
      return { status: 200, json: { ok: true, text: polls === 1 ? 'preflight\nhandover: checks passed\n' : '', to: 30, running: true, state: { step: 'handover', rollbackWhy: null } } }
    }
    const r = await run({ link })
    expect(r.code).toBe(0)
    // Its last line: the old leader still has its hand-off step, and where to check it.
    expect(r.message.split('\n')).toEqual(['Switched: machine-b leads.', 'machine-a still has its final hand-off step (its old home marked handed over, its service set to follow this machine): check it on machine-a with `walnut leader switch --status`'])
    expect(lines).toContain('[on machine-a] preflight')
  })

  it('the leader\'s job refused at its preflight (no state): the command says so with its line', async () => {
    let polls = 0
    const link: LeaderLink = async (method) => {
      if (method === 'POST') return { status: 200, json: { ok: true, leader: 'machine-a' } }
      polls++
      return { status: 200, json: { ok: true, text: polls === 1 ? 'refused: only 1 of 3 witnesses answered\n' : '', to: 10, running: polls === 1, state: null } }
    }
    const r = await run({ link })
    expect(r).toMatchObject({ code: 1, message: 'only 1 of 3 witnesses answered' })
  })
})
