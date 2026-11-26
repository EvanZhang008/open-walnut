/**
 * The leader server's write permission at boot and while it runs (src/core/leader/switch/
 * runtime.ts, boot.ts), over real witness directories: every boot decision, the doors it
 * opens and closes, and that with the experiment off nothing of the permit is reached.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setUpLocalWitnesses, forgetLocalWitnesses } from '../../../../src/core/leader/switch/local-witnesses.js'
import { lagRoundsOf, startPermitRuntime, type PermitRuntime, type WitnessHealth } from '../../../../src/core/leader/switch/runtime.js'
import { leaderPermitAtBoot, LeaderBootRefused } from '../../../../src/core/leader/switch/boot.js'
import { assertOutwardDoor, leaderPermitActive, outwardDoorsOpen, setOutwardDoorChecker } from '../../../../src/core/leader/switch/doors.js'
import { openPermitClient, proposeAndWait, readStanding } from '../../../../src/core/leader/switch/permit-ops.js'
import { readMayAct, readOpOutcomes, readUnresolvedOps, writeMarker, writePromoted } from '../../../../src/core/leader/switch/records.js'
import { DEFAULT_PERMIT_PARAMS } from '../../../../src/core/leader/permit/types.js'
import type { LeaderSwitchSettings, LocalWitnessPlace } from '../../../../src/core/leader/switch/settings.js'

let root = ''
let settings: LeaderSwitchSettings & { witnesses: LocalWitnessPlace[] }
const runtimes: PermitRuntime[] = []
const home = (m: string) => path.join(root, m, 'home')

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-runtime-'))
  const witnesses = ['w1', 'w2', 'w3'].map((id) => ({ id, dir: path.join(root, 'witnesses', id) }))
  setUpLocalWitnesses(witnesses)
  settings = {
    witnesses,
    machines: ['machine-a', 'machine-b'].map((id, i) => ({ id, home: home(id), standbyDir: path.join(root, id, 'standby'), port: 4900 + i })),
    backWindowHours: 24,
    // Short records, so a wait for one to run out takes seconds (the margins still cover the drift bound).
    params: { ...DEFAULT_PERMIT_PARAMS, validMs: 3_000, renewEveryMs: 750, holderMarginMs: 200, witnessMarginMs: 200, minSendRemainingMs: 500, backoffBaseMs: 100, backoffMaxMs: 200 },
  }
  for (const m of settings.machines) fs.mkdirSync(m.home, { recursive: true })
})

afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.stop()
  setOutwardDoorChecker(null)
  forgetLocalWitnesses()
  fs.rmSync(root, { recursive: true, force: true })
})

const start = async (id: string, trial = false, more: { lockPath?: string; commitHandover?: number; witnessHealth?: WitnessHealth; log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void } = {}) => {
  const r = await startPermitRuntime({ home: home(id), holderId: id, settings, trial, ...more })
  runtimes.push(r)
  return r
}

const until = async (what: string, fn: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('boot decisions', () => {
  it('the very first leader grants itself and opens its doors', async () => {
    const r = await start('machine-a')
    expect(r.decision.kind).toBe('lead')
    expect(r.mayAct()).toBe(true)
    expect(outwardDoorsOpen()).toBe(true)
    expect(() => assertOutwardDoor('mail-send', 'op-1')).not.toThrow()
    const lines = readMayAct(home('machine-a'))
    expect(lines.some((l) => l.event === 'door' && l.opId === 'op-1' && l.mayAct)).toBe(true)
  })

  it('a planned restart gives the permission back: the next process of the machine leads at once', async () => {
    const first = await start('machine-a')
    const t0 = Date.now()
    await first.stop()
    forgetLocalWitnesses()
    const again = await start('machine-a')
    expect(again.decision.kind).toBe('lead')
    expect(Date.now() - t0).toBeLessThan(2_500)
    expect(readMayAct(home('machine-a')).some((l) => l.why === 'released (planned stop)')).toBe(true)
  })

  it('a release no witness took (or a crash): the restart waits, doors closed, until the earlier record runs out, then leads', async () => {
    // A record that outlives the stop's release attempt (up to RELEASE_CAP_MS, 3 s) and a loaded
    // machine's restart: with the 3 s record of the other cases it could run out before the
    // restart asks, and the restart would lead at once.
    settings = { ...settings, params: { ...settings.params, validMs: 15_000, renewEveryMs: 2_000 } }
    const first = await start('machine-a')
    for (const w of settings.witnesses) fs.renameSync(w.dir, `${w.dir}.off`)
    await first.stop()
    // The local transport answers on a later tick: let the stop's last release resend reach the
    // missing directories (and fail there) before they come back, or it lands and stands.
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r))
    for (const w of settings.witnesses) fs.renameSync(`${w.dir}.off`, w.dir)
    forgetLocalWitnesses()
    const again = await start('machine-a')
    // The witnesses take a renew only from the process that wrote the record: another process
    // of the same machine is another holder.
    expect(again.decision.kind).toBe('waiting')
    expect(again.decision.kind === 'waiting' && again.decision.why).toMatch(/earlier process of this machine/)
    expect(outwardDoorsOpen()).toBe(false)
    // The client may act a moment before the loop marks the state (acquire returns after the
    // grant stands): wait for both.
    await until('the restarted server to lead', () => again.mayAct() && again.status().state === 'leading', 40_000)
  }, 60_000)

  it('another machine is refused while one holds the permission', async () => {
    await start('machine-a')
    const b = await start('machine-b')
    expect(b.decision.kind).toBe('refuse')
    expect(b.decision.kind === 'refuse' && b.decision.why).toMatch(/name machine machine-a/)
    expect(b.mayAct()).toBe(false)
  })

  it('a home with the handed-over marker refuses, witnesses or not', async () => {
    writeMarker(home('machine-a'), { switchId: 's1', to: 'machine-b', state: 'handed-over', commit: 3, at: new Date().toISOString() })
    for (const w of settings.witnesses) fs.renameSync(w.dir, `${w.dir}.off`)
    const r = await start('machine-a')
    expect(r.decision.kind).toBe('refuse')
    expect(r.decision.kind === 'refuse' && r.decision.why).toMatch(/handed over to machine machine-b/)
  })

  it('a torn marker still refuses', async () => {
    const f = path.join(home('machine-a'), 'local', 'leader-switch', 'handed-over.json')
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, '{"switchId": "s1", "to"')
    const r = await start('machine-a')
    expect(r.decision.kind).toBe('refuse')
  })

  it('no majority answering: boots with every door closed and keeps asking', async () => {
    for (const w of settings.witnesses.slice(0, 2)) fs.renameSync(w.dir, `${w.dir}.off`)
    const r = await start('machine-a')
    expect(r.decision.kind).toBe('waiting')
    expect(r.mayAct()).toBe(false)
    expect(outwardDoorsOpen()).toBe(false)
    expect(() => assertOutwardDoor('push', 'op-2')).toThrow(/write permission not held/)
  })

  it('a leader cut from a majority past its lease stops acting, and leads again by itself once they answer', async () => {
    const r = await start('machine-a')
    expect(r.mayAct()).toBe(true)
    const off = settings.witnesses.slice(1)
    for (const w of off) fs.renameSync(w.dir, `${w.dir}.off`)
    await until('the permission to run out', () => r.status().state === 'waiting', 15_000)
    expect(r.mayAct()).toBe(false)
    // Well past the record's length: the witnesses that come back hold this machine's last renew, long run out.
    await new Promise((res) => setTimeout(res, 4_000))
    for (const w of off) fs.renameSync(`${w.dir}.off`, w.dir)
    // Its lease first, then the runtime's state (it reads the chosen grant on its next look).
    await until('the leader to act again', () => r.mayAct() && r.status().state === 'leading', 15_000)
  }, 40_000)

  it('three witnesses left on three different records of this machine (a renew cut part way): it grants itself and leads again', async () => {
    const r = await start('machine-a')
    const [w1, w2, w3] = settings.witnesses as [LocalWitnessPlace, LocalWitnessPlace, LocalWitnessPlace]
    const numberAt = (w: LocalWitnessPlace) => (JSON.parse(fs.readFileSync(path.join(w.dir, 'permit-record.json'), 'utf8')) as { held: { number: number } | null }).held?.number ?? 0
    const off = (w: LocalWitnessPlace) => fs.renameSync(w.dir, `${w.dir}.off`)
    const on = (w: LocalWitnessPlace) => fs.renameSync(`${w.dir}.off`, w.dir)
    // w3 stops hearing renews; w1 and w2 go on (a majority: the lease holds).
    off(w3)
    const n3 = numberAt({ ...w3, dir: `${w3.dir}.off` })
    await until('w1 and w2 to move past w3', () => numberAt(w2) > n3 && numberAt(w1) > n3)
    // Then w2 too: only w1 takes the renews now, none stands, and the lease runs out.
    off(w2)
    const n2 = numberAt({ ...w2, dir: `${w2.dir}.off` })
    await until('w1 to move past w2', () => numberAt(w1) > n2)
    await until('the permission to run out', () => r.status().state === 'waiting', 15_000)
    on(w2)
    on(w3)
    // Three answers, three records, all this machine's: no record has a majority.
    expect(new Set([numberAt(w1), numberAt(w2), numberAt(w3)]).size).toBe(3)
    await until('the leader to act again', () => r.mayAct() && r.status().state === 'leading', 20_000)
  }, 60_000)

  it('different records of which one is another machine\'s: a grant only when that record never stood (else a switch\'s to settle)', async () => {
    const reply = (witness: string, held: Record<string, unknown> | null) => ({ witness, re: 'read', ok: true, held, list: ['w1', 'w2', 'w3'], joint: null, cfg: 'c', epoch: 0, progress: null, ops: [] })
    const rec = (n: number, holder: string) => ({ kind: 'renew', holder, number: n, by: holder, nonce: 'x', validMs: 1, list: ['w1', 'w2', 'w3'], cfg: 'c', epoch: 0, clock: 'boottime' })
    const h = { client: { witnessList: () => ['w1', 'w2', 'w3'] } }
    const { splitOwnRecordsForTest } = await import('../../../../src/core/leader/switch/runtime.js')
    expect(splitOwnRecordsForTest(h as never, { standing: undefined, replies: [reply('w1', rec(3, 'machine-a')), reply('w2', rec(2, 'machine-a')), reply('w3', rec(1, 'machine-a'))] as never }, 'machine-a')?.want).toBe('grant')
    // Another machine's record that may have stood (w3 holds that machine's later record, so it may have held 2 too): no grant.
    expect(splitOwnRecordsForTest(h as never, { standing: undefined, replies: [reply('w1', rec(3, 'machine-a')), reply('w2', rec(2, 'machine-b')), reply('w3', rec(4, 'machine-b'))] as never }, 'machine-a')).toBeNull()
    // One that never stood: w3 holds a lower number and w1 this machine's renew above it (taken on its own live record, so never on 2).
    expect(splitOwnRecordsForTest(h as never, { standing: undefined, replies: [reply('w1', rec(3, 'machine-a')), reply('w2', rec(2, 'machine-b')), reply('w3', rec(1, 'machine-a'))] as never }, 'machine-a')?.want).toBe('grant')
    // Only one answer: not a majority, nothing is known.
    expect(splitOwnRecordsForTest(h as never, { standing: undefined, replies: [reply('w1', rec(3, 'machine-a'))] as never }, 'machine-a')).toBeNull()
    // The handover of a switch back to this machine, left on one witness: its own once a renew of this machine above it
    // shows it committed (the remote rehearsal's two-down left w-k on 56, w-b on 58, w-a on 63), never before.
    const handover = (n: number) => ({ ...rec(n, 'machine-a'), kind: 'handover', from: 'machine-b', to: 'machine-a', by: 'machine-b' })
    expect(splitOwnRecordsForTest(h as never, { standing: undefined, replies: [reply('w1', rec(63, 'machine-a')), reply('w2', rec(58, 'machine-a')), reply('w3', handover(56))] as never }, 'machine-a')?.want).toBe('grant')
    expect(splitOwnRecordsForTest(h as never, { standing: undefined, replies: [reply('w1', handover(56)), reply('w2', rec(55, 'machine-a')), reply('w3', null)] as never }, 'machine-a')).toBeNull()
    // The handover's writer (machine-b) is left the permission when the new machine's renew above it never stood
    // (w3 holds nothing, w1 the lower handover); not when it may have (two witnesses at or above it).
    expect(splitOwnRecordsForTest(h as never, { standing: undefined, replies: [reply('w1', handover(56)), reply('w2', rec(58, 'machine-a')), reply('w3', null)] as never }, 'machine-b')?.want).toBe('grant')
    expect(splitOwnRecordsForTest(h as never, { standing: undefined, replies: [reply('w1', handover(56)), reply('w2', rec(58, 'machine-a')), reply('w3', rec(57, 'machine-a'))] as never }, 'machine-b')).toBeNull()
    // A switch from this machine that rolled back, its handover left on one witness and two grants of this machine above
    // it on the others (the remote rehearsal's failed trial: w-a 73 handover a -> b, w-b grant 78, w-k grant 74).
    const away = (n: number) => ({ ...rec(n, 'machine-b'), kind: 'handover', from: 'machine-a', to: 'machine-b', by: 'machine-a' })
    const grant = (n: number) => ({ ...rec(n, 'machine-a'), kind: 'grant' })
    expect(splitOwnRecordsForTest(h as never, { standing: undefined, replies: [reply('w1', away(73)), reply('w2', grant(78)), reply('w3', grant(74))] as never }, 'machine-a')?.want).toBe('grant')
    // That handover never stood (w2 lower, w3 empty): machine-b never could commit on it, the permission is machine-a's.
    expect(splitOwnRecordsForTest(h as never, { standing: undefined, replies: [reply('w1', away(73)), reply('w2', grant(72)), reply('w3', null)] as never }, 'machine-a')?.want).toBe('grant')
    // Machine-b's renews above it, one of which may have stood (its commit): the switch's, never machine-a's.
    expect(splitOwnRecordsForTest(h as never, { standing: undefined, replies: [reply('w1', away(73)), reply('w2', rec(75, 'machine-b')), reply('w3', rec(74, 'machine-b'))] as never }, 'machine-a')).toBeNull()
    // Machine-b, the handover's other side, never takes it over from machine-a's grants.
    expect(splitOwnRecordsForTest(h as never, { standing: undefined, replies: [reply('w1', away(73)), reply('w2', grant(78)), reply('w3', grant(74))] as never }, 'machine-b')).toBeNull()
    // A cancel of this machine is a record it leads on (it leads on it at once): the rehearsal's rollback left
    // w1 on the handover (cut during the cancel), w2 on the cancel, w3 on the first renew after it.
    const cancel = (n: number, who = 'machine-a') => ({ ...rec(n, who), kind: 'cancel', from: who })
    expect(splitOwnRecordsForTest(h as never, { standing: undefined, replies: [reply('w1', away(73)), reply('w2', cancel(74)), reply('w3', rec(75, 'machine-a'))] as never }, 'machine-a')?.want).toBe('grant')
    // Another machine's cancel that may have stood (two witnesses at or above it) is not this machine's.
    expect(splitOwnRecordsForTest(h as never, { standing: undefined, replies: [reply('w1', cancel(74, 'machine-b')), reply('w2', rec(75, 'machine-b')), reply('w3', rec(70, 'machine-a'))] as never }, 'machine-a')).toBeNull()
    // A witness list change of this machine is its permission record, as a grant is (the list-change model's split:
    // w1 on its cancel, w2 on its final step that stood, the third not answering).
    const members = (n: number, who = 'machine-a') => ({ ...rec(n, who), kind: 'members', stage: 'final', newList: ['w1', 'w2', 'w3'] })
    expect(splitOwnRecordsForTest(h as never, { standing: undefined, replies: [reply('w1', cancel(5)), reply('w2', members(3))] as never }, 'machine-a')?.want).toBe('grant')
    // Another machine's list change is not this machine's.
    expect(splitOwnRecordsForTest(h as never, { standing: undefined, replies: [reply('w1', cancel(5)), reply('w2', members(3, 'machine-b'))] as never }, 'machine-a')).toBeNull()
  })

  it('a handover to this machine that the switch did not commit: refuses', async () => {
    const a = await start('machine-a')
    const r = await a.handover('machine-b')
    expect(r.ok).toBe(true)
    expect(a.mayAct()).toBe(false)
    expect(a.status().state).toBe('handed-over')
    const b = await start('machine-b')
    expect(b.decision.kind).toBe('refuse')
    expect(b.decision.kind === 'refuse' && b.decision.why).toMatch(/not committed/)
  })

  it('the new leader told the handover number commits it with its own renew; the old one never acts again', async () => {
    const a = await start('machine-a')
    const r = await a.handover('machine-b')
    const b = await start('machine-b', false, { commitHandover: r.record!.number })
    expect(b.decision.kind).toBe('lead')
    expect(b.mayAct()).toBe(true)
    expect(a.mayAct()).toBe(false)
    const reader = openPermitClient('reader', settings.witnesses, settings.params)
    const standing = (await readStanding(reader)).standing
    expect(standing?.holder).toBe('machine-b')
    expect(standing?.kind).toBe('renew')
    // Too late to cancel: the commit stood first.
    const c = await a.cancel()
    expect(c.ok).toBe(false)
    expect(a.mayAct()).toBe(false)
  })

  it('a told number that is not the standing handover is refused', async () => {
    const a = await start('machine-a')
    const r = await a.handover('machine-b')
    const b = await start('machine-b', false, { commitHandover: r.record!.number + 7 })
    expect(b.decision.kind).toBe('refuse')
  })

  it('the old leader cancels its own handover and leads again at once', async () => {
    const a = await start('machine-a')
    await a.handover('machine-b')
    expect(a.mayAct()).toBe(false)
    const c = await a.cancel()
    expect(c.ok).toBe(true)
    expect(a.mayAct()).toBe(true)
    expect(a.status().state).toBe('leading')
  })

  it('red for the old design: a handover written by another process of the holder (the switch command) is refused', async () => {
    await start('machine-a')
    const cli = openPermitClient('machine-a', settings.witnesses, settings.params)
    const r = await proposeAndWait(cli, (c) => c.handover('machine-b'))
    expect(r?.outcome).not.toBe('chosen')
  })

  it('a handover left by a stopped process (the switch rolled back after the stop): the restarted old leader waits it out and grants', async () => {
    const a = await start('machine-a')
    await a.handover('machine-b')
    await a.stop()
    forgetLocalWitnesses()
    const again = await start('machine-a')
    expect(again.decision.kind).toBe('waiting')
    expect(again.decision.kind === 'waiting' && again.decision.why).toMatch(/earlier handover/)
    await until('the old leader to take the permission back', () => again.mayAct())
  })

  it('one leader process per machine: a second one is refused by the instance lock', async () => {
    const lockPath = path.join(root, 'machine-a.lock', 'lock')
    const first = await start('machine-a', false, { lockPath })
    expect(first.decision.kind).toBe('lead')
    const second = await start('machine-a', false, { lockPath })
    expect(second.decision.kind).toBe('refuse')
    expect(second.decision.kind === 'refuse' && second.decision.why).toMatch(/instance lock/)
    expect(first.mayAct()).toBe(true)
  })

  it('a trial start never asks for the permission: doors closed', async () => {
    const r = await start('machine-b', true)
    expect(r.decision.kind).toBe('trial')
    expect(r.mayAct()).toBe(false)
    expect(() => assertOutwardDoor('cron-fire', 'job:1')).toThrow()
    const h = openPermitClient('reader', settings.witnesses, settings.params)
    expect((await readStanding(h)).standing).toBeNull()
  })

  it('a stopped runtime keeps its doors closed, not unchecked', async () => {
    const r = await start('machine-a')
    await r.stop()
    expect(leaderPermitActive()).toBe(true)
    expect(outwardDoorsOpen()).toBe(false)
    expect(() => assertOutwardDoor('mail-send', 'op-3')).toThrow(/stopping/)
  })
})

describe('a witness that takes none of the leader\'s renewals', () => {
  it('is said once (a log line, a Health item) after a lease of renewals, brought back by a grant once its record ran out, and recovers', async () => {
    const told: string[] = []
    const lines: Array<{ msg: string; data?: Record<string, unknown> }> = []
    const witnessHealth: WitnessHealth = { behind: (w, n, why) => told.push(`behind ${w} ${n} ${why}`), back: (w) => told.push(`back ${w}`) }
    const r = await start('machine-a', false, { witnessHealth, log: (_l, msg, data) => lines.push({ msg, data }) })
    expect(r.mayAct()).toBe(true)
    const w3 = settings.witnesses[2]!
    fs.renameSync(w3.dir, `${w3.dir}.off`)
    const rounds = lagRoundsOf(settings.params)
    // A lease of renewals with no answer from w3: said once, and once only however long it lasts.
    await until('w3 reported behind', () => told.length > 0, 15_000)
    expect(told).toEqual([`behind w3 ${rounds} no answer`])
    expect(lines.filter((l) => /took none of this leader's last renewals/.test(l.msg)).map((l) => l.data?.witness)).toEqual(['w3'])
    // Back once A's record there ran out (well past a record's length): it holds nothing live, so it takes no renew,
    // only A's grant (client.ts behind); then it is not behind any more.
    await new Promise((res) => setTimeout(res, 4_000))
    expect(told).toHaveLength(1)
    fs.renameSync(`${w3.dir}.off`, w3.dir)
    await until('w3 back', () => told.includes('back w3'), 15_000)
    expect(r.mayAct()).toBe(true)
    const c = openPermitClient('reader', settings.witnesses, settings.params, () => true)
    const read = await readStanding(c)
    const at3 = read.replies.find((x) => x.witness === 'w3')
    expect(at3?.held?.by).toBe('machine-a')
    expect(at3?.grantable).toBe(false)
    expect(told).toEqual([`behind w3 ${rounds} no answer`, 'back w3'])
  }, 40_000)
})

describe('outward sends: op ids registered first', () => {
  it('a send is registered with a majority, begun once, and its outcome rides the next renew', async () => {
    const a = await start('machine-a')
    await a.beginSend('mail-send', 'mail:k1')
    // One process sends one op at most once.
    await expect(a.beginSend('mail-send', 'mail:k1')).rejects.toThrow()
    a.reportSend('mail:k1', 'sent')
    const lines = readMayAct(home('machine-a'))
    expect(lines.some((l) => l.event === 'door' && l.opId === 'mail:k1' && l.mayAct && l.why === 'send')).toBe(true)
  })

  it('a send the old leader began and never reported is never sent by the new one, and is listed', async () => {
    const a = await start('machine-a')
    await a.beginSend('mail-send', 'mail:k2')
    await a.beginSend('mail-send', 'mail:k3')
    a.reportSend('mail:k3', 'sent')
    const r = await a.handover('machine-b')
    const b = await start('machine-b', false, { commitHandover: r.record!.number })
    expect(b.decision.kind).toBe('lead')
    await expect(b.beginSend('mail-send', 'mail:k2')).rejects.toThrow(/never sent again/)
    await expect(b.beginSend('mail-send', 'mail:k3')).rejects.toThrow(/never sent again/)
    expect(readUnresolvedOps(home('machine-b')).map((o) => o.id)).toEqual(['mail:k2'])
    // The witnesses' "sent" goes into B's data, which outlives their entry.
    expect(readOpOutcomes(home('machine-b')).get('mail:k3')?.state).toBe('sent')
    await b.beginSend('mail-send', 'mail:k4')
  })

  it('no permission, no send', async () => {
    for (const w of settings.witnesses.slice(0, 2)) fs.renameSync(w.dir, `${w.dir}.off`)
    const r = await start('machine-a')
    await expect(r.beginSend('push', 'push:1')).rejects.toThrow(/write permission not held|no live permission/)
  })
})

describe('leaderPermitAtBoot', () => {
  it('with the experiment off returns null and registers nothing', async () => {
    const r = await leaderPermitAtBoot({ home: home('machine-a'), flagOn: false, isLeaderRole: true, ephemeral: false, env: {} })
    expect(r).toBeNull()
    expect(leaderPermitActive()).toBe(false)
    expect(outwardDoorsOpen()).toBe(true)
  })

  it('a handed-over home refuses with the experiment off or the section gone', async () => {
    writeMarker(home('machine-a'), { switchId: 's1', to: 'machine-b', state: 'handed-over', commit: 3, at: new Date().toISOString() })
    await expect(leaderPermitAtBoot({ home: home('machine-a'), flagOn: false, isLeaderRole: true, ephemeral: false, env: {} }))
      .rejects.toThrow(/handed over to machine machine-b/)
    expect(leaderPermitActive()).toBe(false)
    // The refusal carries the standby the server runs instead of exiting (handed-over.ts).
    const err = await leaderPermitAtBoot({ home: home('machine-a'), flagOn: false, isLeaderRole: true, ephemeral: false, env: {} }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LeaderBootRefused)
    expect((err as LeaderBootRefused).standby).toMatchObject({ leader: 'machine-b', switchId: 's1', message: 'this machine handed the leader to machine-b (switch s1)' })
  })

  it('a switch\'s trial or commit start without the permit (experiment off or no section) refuses: it would run with no door closed', async () => {
    await expect(leaderPermitAtBoot({ home: home('machine-b'), flagOn: false, isLeaderRole: true, ephemeral: false, trial: true, env: {} }))
      .rejects.toThrow(/no outward door closed/)
    await expect(leaderPermitAtBoot({ home: home('machine-b'), flagOn: true, isLeaderRole: true, ephemeral: false, env: { WALNUT_LEADER_SWITCH_COMMIT: '4' } }))
      .rejects.toThrow(/no usable leader_switch section/)
  })

  it('a home a switch is still promoting boots only as that switch\'s trial or commit start', async () => {
    writePromoted(home('machine-b'), { switchId: 's2', state: 'promoted', at: new Date().toISOString() })
    await expect(leaderPermitAtBoot({ home: home('machine-b'), flagOn: false, isLeaderRole: true, ephemeral: false, env: {} }))
      .rejects.toThrow(/making into the new leader's home/)
    // Its own trial start passes the promotion check (and then needs the permit: refused here with the experiment off).
    await expect(leaderPermitAtBoot({ home: home('machine-b'), flagOn: false, isLeaderRole: true, ephemeral: false, trial: true, env: {} })).rejects.toThrow(/no outward door closed/)
    writePromoted(home('machine-b'), { switchId: 's2', state: 'led', at: new Date().toISOString() })
    expect(await leaderPermitAtBoot({ home: home('machine-b'), flagOn: false, isLeaderRole: true, ephemeral: false, env: {} })).toBeNull()
  })

  it('with the experiment on but no leader_switch section returns null (the standby copy alone)', async () => {
    fs.writeFileSync(path.join(home('machine-a'), 'config.yaml'), 'experimental:\n  switchable_leader: true\nstandby:\n  dir: /tmp/x\n')
    const r = await leaderPermitAtBoot({ home: home('machine-a'), flagOn: true, isLeaderRole: true, ephemeral: false, env: {} })
    expect(r).toBeNull()
    expect(leaderPermitActive()).toBe(false)
  })

  it('an ephemeral server never asks the witnesses unless told to', async () => {
    writeConfig()
    const r = await leaderPermitAtBoot({ home: home('machine-a'), flagOn: true, isLeaderRole: true, ephemeral: true, env: { WALNUT_MACHINE_ID_FILE: idFile('machine-a') } })
    expect(r).toBeNull()
  })

  it('no machine id: refuses with where it looked', async () => {
    writeConfig()
    await expect(leaderPermitAtBoot({ home: home('machine-a'), flagOn: true, isLeaderRole: true, ephemeral: false, env: { WALNUT_MACHINE_ID_FILE: path.join(root, 'none') } }))
      .rejects.toThrow(LeaderBootRefused)
  })

  it('a refused boot throws the reason', async () => {
    writeConfig()
    await start('machine-b')
    await expect(leaderPermitAtBoot({ home: home('machine-a'), flagOn: true, isLeaderRole: true, ephemeral: false, env: { WALNUT_MACHINE_ID_FILE: idFile('machine-a') } }))
      .rejects.toThrow(/does not start as the leader: the witnesses name machine machine-b/)
    // Another machine leads: the server becomes a standby naming it, the record with it.
    const err = await leaderPermitAtBoot({ home: home('machine-a'), flagOn: true, isLeaderRole: true, ephemeral: false, env: { WALNUT_MACHINE_ID_FILE: idFile('machine-a') } }).catch((e: unknown) => e)
    expect((err as LeaderBootRefused).standby).toMatchObject({ leader: 'machine-b', switchId: null, record: { holder: 'machine-b' } })
    expect((err as LeaderBootRefused).standby?.message).toMatch(/^machine machine-b leads \(permit record \d+\): this machine does not$/)
  })

  it('a forwarded begin kept for a switch whose job died goes at the next boot; a trial start leaves it', async () => {
    writeConfig()
    const kept = path.join(home('machine-a'), 'local', 'leader-switch', 'forwarded-begin-S-dead.json')
    fs.mkdirSync(path.dirname(kept), { recursive: true })
    fs.writeFileSync(kept, '{}')
    await expect(leaderPermitAtBoot({ home: home('machine-a'), flagOn: true, isLeaderRole: true, ephemeral: false, trial: true, env: { WALNUT_MACHINE_ID_FILE: path.join(root, 'none') } })).rejects.toThrow(LeaderBootRefused)
    expect(fs.existsSync(kept)).toBe(true)
    await expect(leaderPermitAtBoot({ home: home('machine-a'), flagOn: true, isLeaderRole: true, ephemeral: false, env: { WALNUT_MACHINE_ID_FILE: path.join(root, 'none') } })).rejects.toThrow(LeaderBootRefused)
    expect(fs.existsSync(kept)).toBe(false)
  })

  it('no machine id is no standby: a refusal that names no other leader carries none', async () => {
    writeConfig()
    const err = await leaderPermitAtBoot({ home: home('machine-a'), flagOn: true, isLeaderRole: true, ephemeral: false, env: { WALNUT_MACHINE_ID_FILE: path.join(root, 'none') } }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LeaderBootRefused)
    expect((err as LeaderBootRefused).standby).toBeUndefined()
  })
})

function idFile(id: string): string {
  const f = path.join(root, `${id}.id`)
  fs.writeFileSync(f, `${id}\n`)
  return f
}

function writeConfig(): void {
  const w = settings.witnesses.map((x) => `    - { id: ${x.id}, dir: ${x.dir} }`).join('\n')
  const m = settings.machines.map((x) => `    - { id: ${x.id}, home: ${x.home}, standby_dir: ${x.standbyDir}, port: ${x.port} }`).join('\n')
  fs.writeFileSync(path.join(home('machine-a'), 'config.yaml'), `experimental:\n  switchable_leader: true\nleader_switch:\n  witnesses:\n${w}\n  machines:\n${m}\n`)
}
