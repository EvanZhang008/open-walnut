/**
 * Why a switch starts the old home again as the standby after its stop (source-job.ts
 * oldMachineStandbyReasons): its witness door, and this machine's session daemon when the old leader's
 * server ran it in its own process (the standby holds that runtime again, web/standby-service.ts).
 * A daemon program of its own outlived the server: nothing then waits on the standby.
 */
import { describe, expect, it } from 'vitest'
import { oldMachineStandbyReasons } from '../../../../src/core/leader/switch/source-job.js'

const remote = [{ id: 'w-a', machine: 'machine-a', url: 'https://a/door' }, { id: 'w-k', url: 'https://k/door' }]
const elsewhere = [{ id: 'w-b', machine: 'machine-b', url: 'https://b/door' }, { id: 'w-k', url: 'https://k/door' }]
const local = [{ id: 'w1', dir: '/w1' }, { id: 'w2', dir: '/w2' }]

describe('the old home runs again as the standby after the switch stop', () => {
  it('for its daemon alone: a server that ran the daemon in its own process, with no witness on its machine', () => {
    expect(oldMachineStandbyReasons(elsewhere, { from: 'machine-a', sourceDaemonInProcess: true })).toEqual({ kept: 'its sessions\' daemon kept', lost: 'its sessions have no daemon' })
    expect(oldMachineStandbyReasons(local, { from: 'machine-a', sourceDaemonInProcess: true })).toEqual({ kept: 'its sessions\' daemon kept', lost: 'its sessions have no daemon' })
  })

  it('for its witness alone, as before, when its daemon is a program of its own', () => {
    expect(oldMachineStandbyReasons(remote, { from: 'machine-a', sourceDaemonInProcess: false })).toEqual({ kept: 'its witness door up', lost: 'its witness is not reached' })
    // A state written before the field (a resumed switch): read as a daemon program, the old behaviour.
    expect(oldMachineStandbyReasons(remote, { from: 'machine-a' })).toEqual({ kept: 'its witness door up', lost: 'its witness is not reached' })
  })

  it('for both, said in one line each', () => {
    expect(oldMachineStandbyReasons(remote, { from: 'machine-a', sourceDaemonInProcess: true })).toEqual({ kept: 'its witness door up, its sessions\' daemon kept', lost: 'its witness is not reached and its sessions have no daemon' })
  })

  it('for neither: no standby is started', () => {
    expect(oldMachineStandbyReasons(elsewhere, { from: 'machine-a', sourceDaemonInProcess: false })).toBeNull()
    expect(oldMachineStandbyReasons(local, { from: 'machine-a' })).toBeNull()
  })
})
