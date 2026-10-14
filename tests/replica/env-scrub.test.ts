/**
 * Env scrub (docs/plan/walnut-replica-servers-impl.md, section 2): a host
 * replica reads WALNUT_FOLLOWER_TOKEN and WALNUT_HOST_DAEMON_DIR once at boot
 * and deletes both from process.env, so no child it spawns (git, a shell, a
 * worker, a model CLI) could present itself to the host daemon as this
 * follower. The real startServer, in this process, as a host replica.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createMockConstants } from '../helpers/mock-constants.js'
import { FOLLOWER_TOKEN, useHostReplicaEnv, type HostReplicaEnv } from '../helpers/replica-host-env.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-replica-env-scrub'))

let env: HostReplicaEnv | null = null
let stopServer: (() => Promise<void>) | null = null

beforeAll(async () => {
  const c = await import('../../src/constants.js')
  env = useHostReplicaEnv(c.WALNUT_HOME)
  ;(await import('../../src/core/server-role.js'))._resetServerRoleForTesting()
  ;(await import('../../src/host-server/env.js'))._resetFollowerSecretsForTesting()
  expect(process.env.WALNUT_FOLLOWER_TOKEN).toBe(FOLLOWER_TOKEN)
  const server = await import('../../src/web/server.js')
  await server.startServer({ port: 0, dev: true })
  stopServer = server.stopServer
}, 120_000)

afterAll(async () => {
  try { await stopServer?.() } catch { /* already down */ }
  env?.restore()
  ;(await import('../../src/core/server-role.js'))._resetServerRoleForTesting()
  ;(await import('../../src/host-server/env.js'))._resetFollowerSecretsForTesting()
}, 60_000)

describe('env scrub on a host replica', () => {
  it('the token and the daemon dir are out of process.env, and kept once for the follower link', async () => {
    expect(process.env.WALNUT_FOLLOWER_TOKEN).toBeUndefined()
    expect(process.env.WALNUT_HOST_DAEMON_DIR).toBeUndefined()
    const { followerSecrets } = await import('../../src/host-server/env.js')
    expect(followerSecrets()).toEqual({ followerToken: FOLLOWER_TOKEN, hostDaemonDir: env!.hostDaemonDir })
  })

  it('a child spawned by the replica (inherited env, and the git child env) carries neither', async () => {
    const run = promisify(execFile)
    const script = 'process.stdout.write(JSON.stringify({ t: process.env.WALNUT_FOLLOWER_TOKEN ?? null, d: process.env.WALNUT_HOST_DAEMON_DIR ?? null }))'
    const inherited = JSON.parse((await run(process.execPath, ['-e', script])).stdout)
    expect(inherited).toEqual({ t: null, d: null })
    const { gitChildEnv } = await import('../../src/lib/git-env.js')
    const viaGit = JSON.parse((await run(process.execPath, ['-e', script], { env: gitChildEnv() })).stdout)
    expect(viaGit).toEqual({ t: null, d: null })
  })

  it('the scrub deletes from the env it is handed, and keeps the values it read', async () => {
    const { takeFollowerSecrets, _resetFollowerSecretsForTesting } = await import('../../src/host-server/env.js')
    const copy: NodeJS.ProcessEnv = { WALNUT_FOLLOWER_TOKEN: 'a', WALNUT_HOST_DAEMON_DIR: '/x', LANG: 'C' }
    _resetFollowerSecretsForTesting()
    expect(takeFollowerSecrets(copy)).toEqual({ followerToken: 'a', hostDaemonDir: '/x' })
    expect(copy).toEqual({ LANG: 'C' })
  })
})
