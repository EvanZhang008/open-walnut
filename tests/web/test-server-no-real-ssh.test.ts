/**
 * A server under test, behind isolateFromRealSsh(), reaches only the stand-in
 * ssh: the end-to-end proof behind tests/core/test-ssh-isolation-ratchet.test.ts.
 *
 * At startup a server sweeps every host it knows, including the Host blocks of
 * ~/.ssh/config, for orphaned terminal sessions over ssh (reapOrphanDtach). A
 * review watched an e2e server do exactly that against the developer's real
 * ssh config and open real ControlMasters. Here the throwaway home has an ssh
 * config naming one host at an unroutable address, and the sweep's ssh call
 * for it lands in the stand-in's log; nothing else ran ssh.
 *
 * Under vitest the startup sweep leaves remote hosts out (reapOrphanDtach's
 * `remoteHosts` is off by default there), so the test runs the sweep with them
 * on, as a server outside a test runner does at startup.
 *
 * A host found in ~/.ssh/config is never dialled before the person says yes
 * (core/hosts/found-hosts.ts, f7a70a356), so the sweep skips it until then.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
import { isolateFromRealSsh, type SshIsolation } from '../helpers/isolate-ssh.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-test-server-no-real-ssh'))

import { startServer, stopServer } from '../../src/web/server.js'

let sshIsolation: SshIsolation | null = null

beforeAll(async () => {
  sshIsolation = isolateFromRealSsh()
  // TEST-NET-1 (RFC 5737): nothing answers there, even if a real ssh ran.
  fs.writeFileSync(path.join(sshIsolation.home, '.ssh', 'config'), 'Host sweep-target\n  HostName 192.0.2.1\n  User nobody\n')
  await startServer({ port: 0, dev: true })
}, 60_000)

afterAll(async () => {
  try { await stopServer() } catch { /* already down */ }
  sshIsolation?.restore()
})

describe('a server under test', () => {
  it('skips a found host until the person says yes, then sweeps it through the stand-in ssh only', async () => {
    const { reapOrphanDtach } = await import('../../src/web/terminal/dtach-lifecycle.js')
    const swept = () => sshIsolation!.calls().some((line) => line.includes('sweep-target'))
    await reapOrphanDtach({ remoteHosts: true })
    expect(swept(), JSON.stringify(sshIsolation!.calls())).toBe(false)

    const { answerFoundHost } = await import('../../src/core/hosts/found-hosts-store.js')
    expect(await answerFoundHost('sweep-target', 'yes')).toMatchObject({ ok: true, answer: 'yes' })
    await reapOrphanDtach({ remoteHosts: true })
    const end = Date.now() + 45_000
    while (Date.now() < end && !swept()) await new Promise((r) => setTimeout(r, 250))
    expect(swept(), JSON.stringify(sshIsolation!.calls())).toBe(true)
  }, 60_000)
})
