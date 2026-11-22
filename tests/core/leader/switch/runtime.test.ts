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
import { startPermitRuntime, type PermitRuntime } from '../../../../src/core/leader/switch/runtime.js'
import { leaderPermitAtBoot, LeaderBootRefused } from '../../../../src/core/leader/switch/boot.js'
import { assertOutwardDoor, leaderPermitActive, outwardDoorsOpen, setOutwardDoorChecker } from '../../../../src/core/leader/switch/doors.js'
import { openPermitClient, proposeAndWait, readStanding } from '../../../../src/core/leader/switch/permit-ops.js'
import { readMayAct, readOpOutcomes, readUnresolvedOps, writeMarker, writePromoted } from '../../../../src/core/leader/switch/records.js'
import { DEFAULT_PERMIT_PARAMS } from '../../../../src/core/leader/permit/types.js'
import type { LeaderSwitchSettings } from '../../../../src/core/leader/switch/settings.js'

let root = ''
let settings: LeaderSwitchSettings
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

const start = async (id: string, trial = false, more: { lockPath?: string; commitHandover?: number } = {}) => {
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
    const first = await start('machine-a')
    for (const w of settings.witnesses) fs.renameSync(w.dir, `${w.dir}.off`)
    await first.stop()
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
    await until('the restarted server to lead', () => again.mayAct() && again.status().state === 'leading')
  })

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
  })

  it('a switch\'s trial or commit start without the permit (experiment off or no section) refuses: it would run with no door closed', async () => {
    await expect(leaderPermitAtBoot({ home: home('machine-b'), flagOn: false, isLeaderRole: true, ephemeral: false, env: { WALNUT_LEADER_TRIAL: '1' } }))
      .rejects.toThrow(/no outward door closed/)
    await expect(leaderPermitAtBoot({ home: home('machine-b'), flagOn: true, isLeaderRole: true, ephemeral: false, env: { WALNUT_LEADER_SWITCH_COMMIT: '4' } }))
      .rejects.toThrow(/no usable leader_switch section/)
  })

  it('a home a switch is still promoting boots only as that switch\'s trial or commit start', async () => {
    writePromoted(home('machine-b'), { switchId: 's2', state: 'promoted', at: new Date().toISOString() })
    await expect(leaderPermitAtBoot({ home: home('machine-b'), flagOn: false, isLeaderRole: true, ephemeral: false, env: {} }))
      .rejects.toThrow(/making into the new leader's home/)
    // Its own trial start passes the promotion check (and then needs the permit: refused here with the experiment off).
    await expect(leaderPermitAtBoot({ home: home('machine-b'), flagOn: false, isLeaderRole: true, ephemeral: false, env: { WALNUT_LEADER_TRIAL: '1' } })).rejects.toThrow(/no outward door closed/)
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
