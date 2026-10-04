/**
 * Fixture for tests/e2e/browser/cloud-host.spec.ts: a primary paired with a
 * REAL cloud companion (a WALNUT_CLOUD_MODE=1 replica in a child process), so
 * the folder picker's Cloud chip, its folders and a session on it are the real
 * tunnel end to end. Only the CLI on the box is a mock.
 *
 * Never :3456 and never the developer's data: every HOME, data dir and daemon
 * dir sits under one temp base, removed on shutdown. The primary is an
 * ephemeral child (argv) with WALNUT_EPHEMERAL_REMOTE_HOSTS=1; an ephemeral
 * server only ever takes a LOOPBACK companion as its cloud box
 * (core/hosts/cloud-box-probe.ts), which this one is.
 *
 * Run: ./node_modules/.bin/tsx tests/e2e/browser/cloud-host-server.ts
 * Reads PW_TEST_PORT (default 3466); prints `CLOUD_HOST_READY <json>`.
 */
import fs from 'node:fs/promises'
import { rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { seedPrimaryPairing, startCloudBoxReplica } from '../../helpers/cloud-box-replica.js'

const port = Number(process.env.PW_TEST_PORT ?? 3466)
if (port === 3456) throw new Error('Production port is forbidden')
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-cloudhost-pw-'))
const macHome = path.join(base, 'mac', 'data')
await fs.mkdir(path.join(macHome, 'tasks'), { recursive: true })

// CLOUD_HOST_SECOND_MAC=1: the companion already serves another Mac (`mac-primary`
// owns its machine credentials) and this Mac is `mac-second`, with none of its own.
const secondMac = process.env.CLOUD_HOST_SECOND_MAC === '1'

// The companion first: the Mac's pairing names its port.
const replica = await startCloudBoxReplica(base, undefined, secondMac ? { machineOwner: 'mac-primary' } : {})

Object.assign(process.env, {
  OPEN_WALNUT_HOME: macHome,
  HOME: path.join(base, 'mac', 'home'),
  USERPROFILE: path.join(base, 'mac', 'home'),
  WALNUT_DAEMON_DIR: path.join(base, 'mac', 'daemon'),
  WALNUT_STREAMS_DIR: path.join(base, 'mac', 'daemon-streams'),
  WALNUT_SPAWN_JOURNAL: path.join(base, 'mac', 'spawn-journal.jsonl'),
  WALNUT_DISABLE_SEARCH: '1',
  WALNUT_DISABLE_BACKGROUND_AI: '1',
  WALNUT_LOCAL_CLAUDE_PROBE: '0',
  WALNUT_EPHEMERAL_REMOTE_HOSTS: '1',
})
await fs.mkdir(process.env.HOME!, { recursive: true })
process.argv.push('--_ephemeral-child')

await fs.writeFile(path.join(macHome, 'tasks', 'tasks.json'), JSON.stringify({ version: 1, tasks: [] }))
await fs.writeFile(path.join(macHome, 'config.yaml'), JSON.stringify({
  version: 1, user: { name: 'Tester' }, defaults: { priority: 'none' },
}))
await seedPrimaryPairing(macHome, `127.0.0.1:${replica.port}`, replica.tokens,
  secondMac ? { as: 'mac-second', secondMac: replica.tokens.secondMac, cachedMachineToken: false } : {})

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
const { startServer, stopServer } = await import('../../../src/web/server.js')
const apiServer = await startServer({ port: 0, dev: true })
const apiAddress = apiServer.address()
if (!apiAddress || typeof apiAddress === 'string') throw new Error('cloud host fixture did not bind a TCP port')
const apiTarget = `http://127.0.0.1:${apiAddress.port}`

const { createServer: createViteServer } = await import('vite')
const { restateOwnOrigin } = await import('../../../web/dev-proxy-origin.js')
const viteServer = await createViteServer({
  root: path.join(repoRoot, 'web'),
  // Its own dependency cache: sharing one another run re-optimizes hands the page two Reacts.
  cacheDir: path.join(base, 'vite-cache'),
  server: {
    host: '127.0.0.1', port, strictPort: true,
    proxy: {
      // The server trusts only its own Origin. Without our own `configure`, the one in
      // web/vite.config.ts survives the merge and restates the page as :3456, so every
      // POST and the WebSocket are refused as cross-site.
      '/api': { target: apiTarget, changeOrigin: true, configure: (proxy) => restateOwnOrigin(proxy, apiTarget) },
      '/ws': { target: apiTarget.replace(/^http/, 'ws'), ws: true, configure: (proxy) => restateOwnOrigin(proxy, apiTarget) },
    },
  },
  logLevel: 'warn',
})
await viteServer.listen()

const fixture = {
  port, apiPort: apiAddress.port, replicaPort: replica.port, projects: replica.box.projects, tunnelDir: replica.box.tunnelDir, base,
  // The box's config.yaml, so a spec can turn cloud.exec off the way an operator would.
  boxConfig: path.join(replica.box.data, 'config.yaml'),
  // The companion's auth.json, so a spec can read who owns its machine credentials.
  boxAuth: path.join(replica.box.data, 'auth.json'),
  // Its data dir and HOME, so a spec can run `walnut device …` there as an operator would.
  boxData: replica.box.data, boxHome: replica.box.home,
  // The device ids its auth.json was seeded with (ownership is keyed by them).
  ids: replica.ids,
}
// Port-keyed, so the spec (which Playwright runs apart from this process) finds it.
const fixtureFile = path.join(os.tmpdir(), `walnut-cloudhost-pw-${port}.json`)
await fs.writeFile(fixtureFile, JSON.stringify(fixture, null, 2))
console.log(`CLOUD_HOST_READY ${JSON.stringify(fixture)}`)

let closing = false
const shutdown = async () => {
  if (closing) return
  closing = true
  // Bounded well inside the config's 45s gracefulShutdown, so the cleanup below
  // runs before Playwright SIGKILLs the group.
  const teardown = (async () => {
    await replica.stop().catch(() => {}) // the box daemon first: it has no watchdog
    await viteServer.close().catch(() => {})
    await stopServer().catch(() => {})
    try {
      const { localDaemon } = await import('../../../src/providers/local-daemon.js')
      await localDaemon.stopIfIsolated()
    } catch { /* best effort */ }
  })()
  await Promise.race([teardown, new Promise((r) => setTimeout(r, 30_000))])
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
// Same two traps as tests/e2e/browser/test-server.ts: startServer() re-raises
// SIGTERM unless an owner will exit after teardown, and Vite's
// `parentSigtermCallback` calls process.exit() mid-teardown. Either one left the
// box daemon running and this temp dir behind on every run.
const { armGracefulSignalExit } = await import('../../../src/web/server.js')
armGracefulSignalExit()
for (const l of process.listeners('SIGTERM')) if (l.name === 'parentSigtermCallback') process.off('SIGTERM', l)
for (const l of process.stdin.listeners('end')) if (l.name === 'parentSigtermCallback') process.stdin.off('end', l as (...args: unknown[]) => void)
// Last word, synchronous and after startServer()'s own 'exit' log write: the
// box daemon (no parent watchdog, by design), the replica and the temp dir.
process.on('exit', () => {
  replica.killNow()
  try { rmSync(base, { recursive: true, force: true, maxRetries: 3 }) } catch { /* best effort */ }
  try { rmSync(fixtureFile, { force: true }) } catch { /* best effort */ }
})
