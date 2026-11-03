/**
 * host_daemon_update (src/core/hosts/host-daemon-update.ts): a task's session asks under
 * the same grant rules as host_exec (the grant, its letter, a closed host), the person at
 * this computer needs none, and a host of a kind that updates another way says so.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-daemon-update-unit'))

const gate = vi.hoisted(() => ({
  grant: null as null | { status: number; code: string },
  asked: [] as Array<{ host: string; preview: string | null }>,
  dialed: [] as string[],
  kind: 'net' as string,
  requests: 0,
}))

vi.mock('../../../src/core/hosts/host-exec.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/core/hosts/host-exec.js')>()
  return {
    ...real,
    callerOf: async () => ({ sid: 's1', taskId: 'task-1', taskTitle: 'Ship it', host: 'devbox' }),
    targetHost: async (raw: string) => raw,
    hostName: async (host: string) => host,
  }
})
// host-exec.js re-exports this module, so its mock must not import host-exec.js (a cycle that never settles).
vi.mock('../../../src/core/hosts/host-exec-grant.js', () => ({
  grantFor: async (_c: unknown, host: string, preview: string | null) => {
    gate.asked.push({ host, preview })
    if (gate.grant) throw Object.assign(new Error('This task may not use it yet: a letter asks the user'), gate.grant)
    return 'g-1'
  },
  isOwnHost: async () => true,
}))
vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: async () => ({ hosts: { 'studio-mac': { transport: 'net' }, devbox: {} } }) }))
vi.mock('../../../src/core/hosts/link.js', () => ({
  link: async (host: string) => {
    gate.dialed.push(host)
    return {
      linkKind: gate.kind,
      requestDaemonUpdate: () => {
        if (gate.kind !== 'net') return null
        gate.requests += 1
        return Promise.resolve({ phase: 'running', host, running: 'walnut-daemon-a', expected: 'walnut-daemon-b', message: 'uploading', at: 1 })
      },
    }
  },
}))

import { requestHostDaemonUpdate } from '../../../src/core/hosts/host-daemon-update.js'

beforeEach(() => {
  gate.grant = null
  gate.asked = []
  gate.dialed = []
  gate.kind = 'net'
  gate.requests = 0
})

describe('host_daemon_update', () => {
  it('a session with the grant starts the update on a host network machine', async () => {
    expect(await requestHostDaemonUpdate('studio-mac', 's1')).toMatchObject({ host: 'studio-mac', phase: 'running', expected: 'walnut-daemon-b' })
    expect(gate.asked).toEqual([{ host: 'studio-mac', preview: expect.stringContaining('walnut daemon update') }])
    expect(gate.requests).toBe(1)
  })

  it('a session without the grant asks the user and changes nothing', async () => {
    gate.grant = { status: 403, code: 'exec_grant_required' }
    await expect(requestHostDaemonUpdate('studio-mac', 's1')).rejects.toMatchObject({ status: 403, code: 'exec_grant_required' })
    gate.grant = { status: 403, code: 'exec_host_closed' }
    await expect(requestHostDaemonUpdate('studio-mac', 's1')).rejects.toMatchObject({ code: 'exec_host_closed' })
    expect(gate.dialed).toEqual([])
    expect(gate.requests).toBe(0)
  })

  it('the person at this computer needs no grant, only a host Walnut knows', async () => {
    expect(await requestHostDaemonUpdate('studio-mac', undefined)).toMatchObject({ phase: 'running' })
    expect(gate.asked).toEqual([])
    await expect(requestHostDaemonUpdate('nowhere', undefined)).rejects.toMatchObject({ status: 404, code: 'unknown_host' })
  })

  it('a host that updates another way says so', async () => {
    gate.kind = 'ssh'
    await expect(requestHostDaemonUpdate('devbox', undefined)).rejects.toMatchObject({ status: 409, code: 'updates_itself', message: expect.stringContaining('over SSH') })
    gate.kind = 'cloud-tunnel'
    await expect(requestHostDaemonUpdate('devbox', undefined)).rejects.toMatchObject({ code: 'updates_itself', message: expect.stringContaining('companion') })
  })
})
