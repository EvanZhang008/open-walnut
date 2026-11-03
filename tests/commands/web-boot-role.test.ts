/**
 * `walnut web`'s boot decision (src/commands/web.ts): which start becomes the
 * looping supervisor, which serves, and the env its children get. A qualifying
 * start nobody supervises supervises (it never boots a server itself); a
 * supervised child always serves, so supervisors never nest.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-web-boot-role'))

import { bootRole } from '../../src/commands/web-restart.js'
import { bootEnvOf } from '../../src/commands/web.js'
import { supervisedChildEnv } from '../../src/core/self-update/restart-supervisor.js'
import { APPLIED_ENV, READY_FILE_ENV, RESTART_EXIT_CODE, RESTART_SUPERVISED_ENV } from '../../src/core/self-update/startup-relaunch.js'

const go = { kind: 'continue' as const }
const role = (o: Partial<Parameters<typeof bootRole>[0]>) =>
  bootRole({ outcome: go, supervised: false, qualifies: async () => false, restartCode: RESTART_EXIT_CODE, ...o })

describe('web boot role', () => {
  it('a qualifying start nobody supervises becomes the supervisor; one that does not qualify serves', async () => {
    expect(await role({ qualifies: async () => true })).toEqual({ kind: 'supervise' })
    expect(await role({ qualifies: async () => false })).toEqual({ kind: 'serve' })
  })

  it('a supervised child serves without asking (no supervisor under a supervisor)', async () => {
    const qualifies = vi.fn(async () => true)
    expect(await role({ supervised: true, qualifies })).toEqual({ kind: 'serve' })
    expect(qualifies).not.toHaveBeenCalled()
  })

  it('an error deciding serves as before', async () => {
    expect(await role({ qualifies: async () => { throw new Error('ps failed') } })).toEqual({ kind: 'serve' })
  })

  it('after a startup update ran the new version: its exit 75 loops, any other code ends this process with it', async () => {
    const qualifies = vi.fn(async () => true)
    expect(await role({ outcome: { kind: 'reexeced', exitCode: RESTART_EXIT_CODE }, qualifies })).toEqual({ kind: 'loop', firstCode: RESTART_EXIT_CODE })
    expect(await role({ outcome: { kind: 'reexeced', exitCode: 0 }, qualifies })).toEqual({ kind: 'exit', code: 0 })
    expect(await role({ outcome: { kind: 'reexeced', exitCode: 143 }, qualifies })).toEqual({ kind: 'exit', code: 143 })
    expect(qualifies).not.toHaveBeenCalled()
  })
})

describe('the env a supervised child starts with', () => {
  const started = {
    LANG: 'C', HOME: '/home/x', WALNUT_HOME: '/data',
    WALNUT_SESSION_ID: 'sess-1', WALNUT_AGENT_SOCKET: '/tmp/s', WALNUT_TASK_DIR: '/tasks/t',
    OPEN_WALNUT_EXIT_ON_ORPHAN: '1', [READY_FILE_ENV]: '/tmp/ready', [APPLIED_ENV]: '1', [RESTART_SUPERVISED_ENV]: '1',
  }

  it('the boot env keeps the start\'s own env and drops a session identity and the orphan request, without touching the original', () => {
    const boot = bootEnvOf({ ...started })
    expect(boot).toMatchObject({ LANG: 'C', HOME: '/home/x', WALNUT_HOME: '/data' })
    for (const k of ['WALNUT_SESSION_ID', 'WALNUT_AGENT_SOCKET', 'WALNUT_TASK_DIR', 'OPEN_WALNUT_EXIT_ON_ORPHAN']) expect(boot[k]).toBeUndefined()
    const original = { ...started }
    bootEnvOf(original)
    expect(original.WALNUT_SESSION_ID).toBe('sess-1')
  })

  it('the child is marked supervised, with no parent ready file and no update marker of this process', () => {
    const env = supervisedChildEnv(bootEnvOf({ ...started }))
    expect(env[RESTART_SUPERVISED_ENV]).toBe('1')
    expect(env[READY_FILE_ENV]).toBeUndefined()
    expect(env[APPLIED_ENV]).toBeUndefined()
    expect(env.LANG).toBe('C')
  })
})
