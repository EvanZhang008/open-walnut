/**
 * The host sign-in letter wired the way the server wires it: real host:status
 * frames on the real bus, the real letter store and the real config. One letter
 * for one expired login, archived when the host connects, the user's hint from
 * config, and a restart that sends nothing twice.
 *
 * WALNUT_HOME is an isolated tmpdir (createMockConstants).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { bus, EventNames } from '../../src/core/event-bus.js'
import { listLetters } from '../../src/core/human-inbox/store.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { runningHostAuthAlert, startHostAuthAlert } from '../../src/core/hosts/host-auth-alert.js'

const CERT = 'Permission denied (publickey).\nwalnut-ssh-evidence: cert-expired (SSH certificate expired)'
const frame = (host: string, over: Record<string, unknown>) =>
  bus.emit(EventNames.HOST_STATUS, { host, label: 'Dev box', at: Date.now(), ...over }, ['web-ui'])

async function settle(): Promise<string | null> {
  return (await runningHostAuthAlert()!.openLetterIds())[0] ?? null
}

describe('host sign-in letter, end to end through the store', () => {
  let stop: (() => void) | null = null
  beforeAll(async () => { await updateConfig({ ssh_login_hint: 'run the login command on this Mac' }) })
  afterEach(() => { stop?.(); stop = null })

  it('one letter for repeated failures, archived when the host connects; a restart sends nothing more', async () => {
    stop = await startHostAuthAlert({ knownHosts: () => new Set(['dev']) })
    runningHostAuthAlert()!.configure({ graceMs: 0 })
    for (let i = 0; i < 3; i++) {
      frame('dev', { connected: false, phase: 'failed', kind: 'cert_expired', error: CERT })
      frame('dev', { connected: false, phase: 'ssh' })
    }
    await settle()
    await runningHostAuthAlert()!.check()
    const id = await settle()
    expect(id).toMatch(/^lt-/)

    let live = (await listLetters()).letters.filter((l) => l.createdByOp?.startsWith('host-sign-in:'))
    expect(live).toHaveLength(1)
    expect(live[0].subject).toBe('SSH sign-in to Dev box failed: run the login command on this Mac')
    expect(live[0].type).toBe('review')
    expect(live[0].sender.sessionId).toBe('external')

    // The server restarts while the login is still expired.
    stop(); stop = null
    stop = await startHostAuthAlert({ knownHosts: () => new Set(['dev']) })
    runningHostAuthAlert()!.configure({ graceMs: 0 })
    frame('dev', { connected: false, phase: 'reconnecting', lastKind: 'cert_expired', lastError: CERT })
    await settle()
    await runningHostAuthAlert()!.check()
    expect(await settle()).toBe(id)
    live = (await listLetters()).letters.filter((l) => l.createdByOp?.startsWith('host-sign-in:'))
    expect(live).toHaveLength(1)

    // The user logged in: the host connects and the letter leaves the live feed.
    frame('dev', { connected: true, phase: 'connected' })
    expect(await settle()).toBeNull()
    expect((await listLetters()).letters.filter((l) => l.createdByOp?.startsWith('host-sign-in:'))).toHaveLength(0)
    const shelf = (await listLetters({ archived: true })).letters.filter((l) => l.id === id)
    expect(shelf).toHaveLength(1)
    expect(shelf[0].archived).toBe(true)
  })

  it('a host that is only unreachable writes no letter', async () => {
    stop = await startHostAuthAlert({ knownHosts: () => new Set(['dev']) })
    runningHostAuthAlert()!.configure({ graceMs: 0 })
    const before = (await listLetters()).letters.length
    frame('dev', { connected: false, phase: 'failed', kind: 'unreachable', error: 'ssh: connect to host dev port 22: No route to host' })
    await settle()
    await runningHostAuthAlert()!.check()
    expect(await settle()).toBeNull()
    expect((await listLetters()).letters.length).toBe(before)
  })
})
