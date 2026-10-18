/**
 * The last link of a host's copy target: the real host-server manager of this
 * server (src/core/host-server/index.ts getHostServerManager) registers
 * `host:<key>` with replica-targets.ts while the host's server starts, and
 * tells THAT target when the server answers, so every copy runs its round
 * within its debounce (onReplicaTargetsChanged), with no task event. A new
 * server process there forgets the target's memos and rests; the same process
 * answering again after a reconcile does not. Stand-ins: the host's daemon (a
 * fake, as in host-server-manager.test.ts), this server's tunnel port, and a
 * local app dir in place of an install (WALNUT_HOST_SERVER_APP_DIR).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-target-wiring', { CLOUD_MODE: false }))
vi.mock('../../src/web/expose-runtime.js', () => ({
  getExposeRuntime: () => ({ holdTunnelPort: async () => 5555, releaseTunnelPort: async () => {} }),
}))

import { CONFIG_FILE } from '../../src/constants.js'
import { getHostServerManager, hostServerConnected, _resetHostServerManagerForTesting } from '../../src/core/host-server/index.js'
import type { HostServerHost } from '../../src/core/host-server/manager.js'
import { onReplicaTargetsChanged, replicaTargets, _resetReplicaTargetsForTesting } from '../../src/core/replication/replica-targets.js'
import { kindState, peekKindState, _resetReplicaStatusForTesting } from '../../src/core/replication/replica-status.js'

/** The host's daemon: it runs the server it is configured with, under `pid`, and reports for it. */
const daemon = { pid: 4242, running: false }

const host: HostServerHost = {
  hostKey: 'devbox',
  connected: true,
  hasCapability: (cap) => ['host-server-v1', 'follower-v1', 'stream-relay-v1'].includes(cap),
  async send(cmd, params) {
    if (cmd === 'host.preflight') return { ok: true, result: { nodeDir: '/opt/node24/bin' } }
    if (cmd === 'server.configure') {
      daemon.running = !!params?.spec
      return { ok: true, status: { state: daemon.running ? 'running' : 'off', since: 0, restarts: 0 } }
    }
    if (cmd === 'server.status') {
      const report = daemon.running ? { report: { route: { kind: 'leader' } }, reportAgeMs: 1_000 } : {}
      return { ok: true, status: { state: daemon.running ? 'running' : 'off', since: 0, restarts: 0, pid: daemon.pid, ...report } }
    }
    return { ok: false, error: 'unknown' }
  },
  async runRemoteScript(script) {
    if (script.includes(' -v 2>&1')) return 'v24.3.0'
    if (script === 'printf %s "$HOME"') return '/home/me'
    if (script.includes('require("net")')) return script.split(' ').filter((w) => /^\d{5}$/.test(w)).map((p) => `${p}:free`).join('\n')
    throw new Error('unexpected script: ' + script.slice(0, 80))
  },
  async uploadFile() { throw new Error('no upload: the app dir stands in for an install') },
  async openStream() { throw new Error('no stream: nothing is posted in this test') },
}

const TARGET = 'host:devbox'
/** The manager's phase for the host at each change of the copy targets. */
let changes: string[] = []
let unlisten = (): void => {}

beforeAll(() => {
  process.env.WALNUT_HOST_SERVER_APP_DIR = '/work/walnut-tree'
  fs.writeFileSync(CONFIG_FILE, 'hosts:\n  devbox:\n    label: Dev box\n    server:\n      enabled: true\n')
  _resetReplicaTargetsForTesting()
  _resetReplicaStatusForTesting()
  unlisten = onReplicaTargetsChanged(() => {
    changes.push(`${getHostServerManager()?.view('devbox').phase}:${replicaTargets().map((t) => t.id).join(',')}`)
  })
})

afterAll(() => {
  unlisten()
  _resetHostServerManagerForTesting()
  _resetReplicaTargetsForTesting()
  delete process.env.WALNUT_HOST_SERVER_APP_DIR
})

describe('a host copy target through the real host-server wiring', () => {
  it('is registered as host:<key> while its server starts, and told under that id once it answers', async () => {
    await hostServerConnected(host)
    expect(getHostServerManager()!.view('devbox').phase).toBe('running')
    // One change for the registration, one for the ready: both name the target the copies serve.
    await expect.poll(() => changes.length).toBe(2)
    expect(changes).toEqual([expect.stringMatching(`:companion,${TARGET}$`), `running:companion,${TARGET}`])
    expect(await replicaTargets().find((t) => t.id === TARGET)!.available()).toBe(true)
  })

  it('a reconcile of the same process keeps the memo and the rests; another process answering forgets them', async () => {
    const st = kindState({ id: TARGET, kind: 'host', label: 'devbox' }, 'tasks')
    Object.assign(st, { manifest: 'abcdef012345', restUntil: Date.now() + 600_000, restWhy: 'schema_newer' })
    const before = changes.length
    // A settings change: checking, starting, running again, the same pid.
    await getHostServerManager()!.reconcile('devbox')
    await expect.poll(() => changes.length).toBe(before + 1)
    expect(changes.at(-1)).toBe(`running:companion,${TARGET}`)
    expect(peekKindState(TARGET, 'tasks')).toMatchObject({ manifest: 'abcdef012345', restWhy: 'schema_newer' })
    // The daemon restarted the server (a crash, a new build): another pid answers.
    daemon.pid = 5151
    await getHostServerManager()!.reconcile('devbox')
    await expect.poll(() => peekKindState(TARGET, 'tasks')?.manifest).toBeNull()
    expect(peekKindState(TARGET, 'tasks')).toMatchObject({ restUntil: 0 })
    expect(peekKindState(TARGET, 'tasks')?.restWhy).toBeUndefined()
    expect(changes.length).toBe(before + 2)
  })
})
