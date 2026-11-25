/**
 * Why a switch starts the old home again as the standby after its stop (source-job.ts
 * oldMachineStandbyReasons): its witness door, and this machine's session daemon when the old leader's
 * server ran it in its own process (the standby holds that runtime again, web/standby-service.ts).
 * A daemon program of its own outlived the server: nothing then waits on the standby. A host's one Walnut
 * service is started again by its launcher, as the standby: the switch starts no second process beside it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { oldLeaderRestartedBy, oldMachineStandbyReasons } from '../../../../src/core/leader/switch/source-job.js'
import { standbyAfterRollback } from '../../../../src/core/leader/switch/target-job.js'
import { cleanStartEnv } from '../../../../src/core/leader/switch/side.js'
import { writeMarker } from '../../../../src/core/leader/switch/records.js'

const remote = [{ id: 'w-a', machine: 'machine-a', url: 'https://a/door' }, { id: 'w-k', url: 'https://k/door' }]
const elsewhere = [{ id: 'w-b', machine: 'machine-b', url: 'https://b/door' }, { id: 'w-k', url: 'https://k/door' }]
const local = [{ id: 'w1', dir: '/w1' }, { id: 'w2', dir: '/w2' }]

describe('the old home runs again as the standby after the switch stop', () => {
  it('for its daemon alone: a server that ran the daemon in its own process, with no witness on its machine', () => {
    expect(oldMachineStandbyReasons(elsewhere, { from: 'machine-a', sourceDaemonShape: 'in-process' })).toEqual({ kept: 'its sessions\' daemon kept', lost: 'its sessions have no daemon' })
    expect(oldMachineStandbyReasons(local, { from: 'machine-a', sourceDaemonShape: 'in-process' })).toEqual({ kept: 'its sessions\' daemon kept', lost: 'its sessions have no daemon' })
  })

  it('for its witness alone, as before, when its daemon is a program of its own', () => {
    expect(oldMachineStandbyReasons(remote, { from: 'machine-a', sourceDaemonShape: 'program' })).toEqual({ kept: 'its witness door up', lost: 'its witness is not reached' })
    // A state written before the field (a resumed switch): read as a daemon program, the old behaviour.
    expect(oldMachineStandbyReasons(remote, { from: 'machine-a' })).toEqual({ kept: 'its witness door up', lost: 'its witness is not reached' })
  })

  it('for both, said in one line each', () => {
    expect(oldMachineStandbyReasons(remote, { from: 'machine-a', sourceDaemonShape: 'in-process' })).toEqual({ kept: 'its witness door up, its sessions\' daemon kept', lost: 'its witness is not reached and its sessions have no daemon' })
  })

  it('a host\'s one Walnut service: never, whatever it keeps (its launcher starts the service again as the standby, which holds both)', () => {
    expect(oldMachineStandbyReasons(remote, { from: 'machine-a', sourceDaemonShape: 'service' })).toBeNull()
    expect(oldMachineStandbyReasons(elsewhere, { from: 'machine-a', sourceDaemonShape: 'service' })).toBeNull()
  })

  it('for neither: no standby is started', () => {
    expect(oldMachineStandbyReasons(elsewhere, { from: 'machine-a', sourceDaemonShape: 'program' })).toBeNull()
    expect(oldMachineStandbyReasons(local, { from: 'machine-a' })).toBeNull()
  })
})

describe('the target\'s rollback starts the old home again as the standby', () => {
  it('only for a handed-over home that no launcher starts again (a service install root: its launcher does)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-standby-'))
    try {
      expect(standbyAfterRollback(home, () => null)).toBe(false)
      writeMarker(home, { switchId: 's1', to: 'machine-b', state: 'switching', handover: 4, at: new Date().toISOString() })
      expect(standbyAfterRollback(home, () => null)).toBe(false)
      writeMarker(home, { switchId: 's1', to: 'machine-b', state: 'handed-over', commit: 5, at: new Date().toISOString() })
      expect(standbyAfterRollback(home, () => null)).toBe(true)
      expect(standbyAfterRollback(home, () => '/opt/walnut-install')).toBe(false)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })
})

describe('the standby the switch starts gets a clean env', () => {
  it('keeps the account basics and the machine\'s daemon placement, never the switch job\'s session identity', () => {
    const env = cleanStartEnv({
      HOME: '/home/u', PATH: '/usr/bin', USER: 'u', TZ: 'UTC',
      WALNUT_DAEMON_DIR: '/tmp/open-walnut', WALNUT_DAEMON_STATE_DIR: '/opt/w', WALNUT_IN_PROCESS_DAEMON: '0', XDG_RUNTIME_DIR: '/run/user/1',
      CLAUDECODE: '1', WALNUT_SESSION_ID: 'sess-1', WALNUT_TASK_DIR: '/tasks/t', VITEST: 'true', OPEN_WALNUT_HOME: '/the/jobs/home', NODE_OPTIONS: '--inspect',
    })
    expect(env).toEqual({
      HOME: '/home/u', PATH: '/usr/bin', USER: 'u', TZ: 'UTC',
      WALNUT_DAEMON_DIR: '/tmp/open-walnut', WALNUT_DAEMON_STATE_DIR: '/opt/w', WALNUT_IN_PROCESS_DAEMON: '0', XDG_RUNTIME_DIR: '/run/user/1',
    })
  })
})

describe('the source job\'s rollback starts the old leader again', () => {
  it('itself for a plain server, never beside a service, whose launcher starts it again as the leader', () => {
    expect(oldLeaderRestartedBy({ sourceDaemonShape: 'in-process' })).toBe('job')
    expect(oldLeaderRestartedBy({ sourceDaemonShape: 'program' })).toBe('job')
    // A source older than the shape field: as before, the job starts it.
    expect(oldLeaderRestartedBy({})).toBe('job')
    expect(oldLeaderRestartedBy({ sourceDaemonShape: 'service' })).toBe('launcher')
  })
})
