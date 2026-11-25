/**
 * host_daemon_update with `over_busy` on an SSH host (2026-11-25): a host that is never quiet
 * (about 95 CLIs, constant gateway relays) refused every asked update as busy, so the build never
 * landed. With the option, the asked build takes the forced path an overdue update takes
 * (daemon-over-busy.ts: OVER_BUSY_FLAG through `overBusy`); without it, it waits as before. A busy
 * refusal's answer names what the daemon counted open and what the option does.
 *
 * The host network path's twin is in daemon-net-update.test.ts ("asked with over_busy").
 * All SSH is stubbed at sshExec (tests/helpers/daemon-connection-update-stubs.ts); no process,
 * socket or tunnel is created.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const { managedUpdate } = vi.hoisted(() => ({ managedUpdate: vi.fn() }))
vi.mock('../../src/providers/daemon-service-update.js', () => ({ updateRemoteDaemonService: managedUpdate }))
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { log } from '../../src/logging/index.js'
import { setAcpUpgradeHoldFileForTest } from '../../src/providers/acp-upgrade-hold.js'
import { resetBusyRetryForTest } from '../../src/providers/daemon-busy-retry.js'
import { resetDaemonUpdateClaims } from '../../src/providers/daemon-update-claim.js'
import { busyOpenWords, DAEMON_BUSY_WORDS, daemonBusyWhy } from '../../src/providers/daemon-busy-words.js'
import { createDaemonCommandDrain } from '../../src/providers/daemon-command-drain.js'
import { OVER_BUSY_GOES_OVER } from '../../src/providers/daemon-over-busy.js'
import { EXPECTED, MANAGED, OLD, TARGET, priv, state, stub } from '../helpers/daemon-connection-update-stubs.js'

const BUSY = 'Managed daemon update failed: Error: service.handover: active ACP workers or relay requests must finish first (open: 2 ACP workers, 14 relay requests)'
const HINT = `; host_daemon_update devbox with over_busy goes ahead now: ${OVER_BUSY_GOES_OVER}`

let conns: DaemonConnection[] = []
let holdDir = ''
afterEach(() => {
  for (const c of conns) { state(c)._connected = false; c.disconnect() }
  conns = []
  managedUpdate.mockReset()
  resetBusyRetryForTest()
  resetDaemonUpdateClaims()
  setAcpUpgradeHoldFileForTest(null)
  if (holdDir) fs.rmSync(holdDir, { recursive: true, force: true })
  holdDir = ''
  vi.restoreAllMocks()
})

/** A live link to a service-managed daemon of the old build; `refuse` makes the next tries refused as busy. */
function make(): { c: DaemonConnection; over: Array<boolean | undefined>; refuse: (n: number) => void } {
  holdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'over-busy-ask-'))
  setAcpUpgradeHoldFileForTest(path.join(holdDir, 'holds.json'))
  const c = new DaemonConnection('devbox', TARGET)
  conns.push(c)
  stub(c, { probe: MANAGED, version: OLD })
  vi.spyOn(log.session, 'info').mockImplementation(() => {})
  vi.spyOn(log.session, 'warn').mockImplementation(() => {})
  vi.spyOn(priv(c), 'serviceDaemonSource').mockResolvedValue({ binary: '/fixture/daemon' })
  vi.spyOn(priv(c), 'handleConnectionLost').mockImplementation(() => { state(c)._connected = false })
  const over: Array<boolean | undefined> = []
  let refusals = 0
  managedUpdate.mockImplementation(async (_s: unknown, _v: unknown, _io: unknown, _scope: unknown, opts?: { onStaged?: () => boolean | Promise<boolean>; overBusy?: boolean }) => {
    over.push(opts?.overBusy)
    if (refusals > 0) { refusals -= 1; throw new Error(BUSY) }
    return (await opts?.onStaged?.()) === false ? 'held' : 'applied'
  })
  state(c)._connected = true
  return { c, over, refuse: (n) => { refusals = n } }
}

/** The automatic decision a postpone's timer runs, now (no ask passed, the busy clock forgotten). */
async function nextAutomaticTry(c: DaemonConnection): Promise<void> {
  clearTimeout(state(c).upgradeRecheckTimer as ReturnType<typeof setTimeout>)
  state(c).upgradeRecheckTimer = null
  resetBusyRetryForTest()
  state(c)._connected = true
  await priv(c).recheckPostponedUpgrade()
}

describe('an SSH host\'s daemon asked for with over_busy', () => {
  it('without the option waits for the host\'s work, and the busy answer names what is open and what over_busy does', async () => {
    const { c, over, refuse } = make()
    refuse(1)
    const answer = await c.requestDaemonUpdate()
    expect(over).toEqual([false])
    expect(answer).toMatchObject({ phase: 'postponed', expected: EXPECTED })
    expect(answer!.message).toBe(`waiting: the host's daemon is busy (open there: 2 ACP workers, 14 relay requests)${HINT}`)
  })

  it('with the option the asked build goes over the work, on its next automatic try too, and its busy answer offers nothing more', async () => {
    const { c, over, refuse } = make()
    refuse(1)
    const answer = await c.requestDaemonUpdate(undefined, { overBusy: true })
    expect(answer!.message).toBe('waiting: the host\'s daemon is busy (open there: 2 ACP workers, 14 relay requests)')
    await nextAutomaticTry(c)
    expect(over).toEqual([true, true])
  })

  it('an ask again while one runs adds over_busy for the tries after it', async () => {
    const { c, over, refuse } = make()
    refuse(1)
    await c.requestDaemonUpdate()
    // The asker's words of the latest ask count.
    await c.requestDaemonUpdate(undefined, { overBusy: true })
    expect(over).toEqual([false, true])
  })

  it('goes over a host_exec run the plain ask waits for', async () => {
    const { c, over } = make()
    state(c)._capabilities = ['host-exec-v1']
    vi.spyOn(c, 'send').mockImplementation((async (cmd: string) => (cmd === 'exec.list' ? { ok: true, jobs: [{ jobId: 'hx-long', running: true }] } : { ok: true })) as never)
    expect(await c.requestDaemonUpdate()).toMatchObject({ phase: 'postponed', message: expect.stringContaining('host_exec') })
    expect(over).toEqual([])
    clearTimeout(state(c).upgradeRecheckTimer as ReturnType<typeof setTimeout>)
    state(c).upgradeRecheckTimer = null
    expect(await c.requestDaemonUpdate(undefined, { overBusy: true })).toMatchObject({ phase: 'running' })
    expect(over).toEqual([true])
  })

  it('is the asked build\'s only: an automatic try of another build, and a later plain ask, wait for the work again', async () => {
    const { c, over, refuse } = make()
    refuse(2)
    await c.requestDaemonUpdate(undefined, { overBusy: true })
    // A plain ask after it: the latest asker's words count.
    await c.requestDaemonUpdate()
    expect(over).toEqual([true, false])
    // Another build expected now: no ask of it, nothing forced.
    vi.spyOn(priv(c), 'getExpectedDaemonVersion').mockReturnValue('walnut-daemon-newer0')
    await nextAutomaticTry(c)
    expect(over).toEqual([true, false, false])
  })

  it('asked again after a busy refusal, the answer says the last try\'s hold while the next one is still checking', async () => {
    const { c, refuse } = make()
    refuse(1)
    await c.requestDaemonUpdate()
    let release!: () => void
    vi.spyOn(priv(c), 'recheckPostponedUpgrade').mockImplementation(() => new Promise<boolean>((r) => { release = () => r(false) }))
    // The route's wait, short: the answer comes while the try still runs.
    const requested = state(c)._requested as { request(waitMs: number): Promise<{ phase: string; message: string }> }
    expect(await requested.request(10)).toMatchObject({
      phase: 'checking', message: `checking the host's daemon; the last try: the host's daemon is busy (open there: 2 ACP workers, 14 relay requests)${HINT}`,
    })
    release()
  })
})

describe('the busy refusal\'s words', () => {
  it('a daemon counts what is open after the busy words, which every reader still knows', async () => {
    expect(busyOpenWords([[2, 'ACP worker'], [0, 'relay request'], [1, 'host_exec run']])).toBe(' (open: 2 ACP workers, 1 host_exec run)')
    expect(busyOpenWords([[0, 'request']])).toBe('')
    const drain = createDaemonCommandDrain()
    let end!: () => void
    drain.admit(() => new Promise<void>((r) => { end = r }))
    let said = ''
    try { drain.pause() } catch (err) { said = (err as Error).message }
    expect(said).toBe('Daemon has active operations; retry after they finish (open: 1 request)')
    expect(DAEMON_BUSY_WORDS.test(said)).toBe(true)
    end()
  })

  it('names the daemon\'s counts, or an older daemon\'s refusal as it said it, and offers over_busy only when not already going over', () => {
    expect(daemonBusyWhy(new Error(BUSY), { host: 'devbox', forced: false })).toBe(`the host's daemon is busy (open there: 2 ACP workers, 14 relay requests)${HINT}`)
    expect(daemonBusyWhy(new Error(BUSY), { host: 'devbox', forced: true })).toBe('the host\'s daemon is busy (open there: 2 ACP workers, 14 relay requests)')
    const older = 'Managed daemon update failed: Daemon has active operations; retry after they finish'
    expect(daemonBusyWhy(new Error(older), { host: 'devbox', forced: true })).toBe(`the host's daemon is busy (${older})`)
    // Two refusals in one answer (the CLI's plain asks): each count once.
    const both = `${BUSY}\nthen: Daemon has active operations; retry after they finish (open: 3 requests)`
    expect(daemonBusyWhy(both, { host: 'devbox', forced: true })).toBe('the host\'s daemon is busy (open there: 2 ACP workers, 14 relay requests; 3 requests)')
  })
})
