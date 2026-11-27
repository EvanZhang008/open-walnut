/**
 * Fixture server for automated-client-sender.spec.ts: a Walnut that attributes a browser under
 * automation to an agent, as the user's own install does (src/core/sessions/automated-client.ts).
 *
 * Its own server, not the shared :3457 fixture: a throwaway server lets automation stand in for
 * the person (every other spec types into the composer as "the person"), so only this one turns the
 * rule on (WALNUT_AUTOMATED_CLIENT_AGENT=1). One task with one stopped session; a send resumes it on
 * the repo's mock CLI, which writes the transcript the spec reads back.
 *
 * Never :3456 and never the developer's data: the data home, HOME and the daemon dirs all point
 * inside one temp directory that is removed on shutdown.
 *
 * Run: bun tests/e2e/browser/automated-client-server.ts
 * Reads PW_AUTOMATED_PORT; prints `AUTOMATED_CLIENT_READY <json>` when it is serving.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fixtureHome } from './fixture-home'

const port = Number(process.env.PW_AUTOMATED_PORT ?? 3466)
const tmpBase = await fixtureHome(path.join(os.tmpdir(), `walnut-automated-client-${port}-${Date.now()}`))

// Before any server import: constants.ts resolves the data home at import time.
process.env.OPEN_WALNUT_HOME = tmpBase
process.env.WALNUT_DAEMON_DIR = path.join(tmpBase, 'daemon')
process.env.WALNUT_STREAMS_DIR = path.join(tmpBase, 'daemon-streams')
process.env.WALNUT_DISABLE_SEARCH = '1'
process.env.WALNUT_DISABLE_BACKGROUND_AI = '1'
process.env.WALNUT_AUTOMATED_CLIENT_AGENT = '1'
process.env.HOME = tmpBase
process.env.USERPROFILE = tmpBase
process.argv.push('--_ephemeral-child', '--_own-accounts')

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

await fs.rm(tmpBase, { recursive: true, force: true })
await fs.mkdir(path.join(tmpBase, 'tasks'), { recursive: true })
await fs.writeFile(path.join(tmpBase, 'config.yaml'), JSON.stringify({
  version: 1,
  defaults: { priority: 'none', platform: 'local' },
  provider: { type: 'claude-code' },
  agent: { main_provider: 'store-cli', main_model: 'store-mock', triage: { debounce_minutes: 0 } },
  providers: { 'store-cli': { api: 'claude-cli', claude_cli_command: path.join(repoRoot, 'tests/providers/mock-main-agent.mjs') } },
}, null, 2))
await fs.writeFile(path.join(tmpBase, 'tasks', 'tasks.json'), JSON.stringify({ version: 1, tasks: [] }, null, 2))

const { startServer, stopServer } = await import('../../../src/web/server.js')
const apiServer = await startServer({ port: 0, dev: true })
const apiAddress = apiServer.address()
if (!apiAddress || typeof apiAddress === 'string') throw new Error('Automated client fixture did not bind a TCP port')
const apiTarget = `http://127.0.0.1:${apiAddress.port}`

// No CLI ever starts here, the machine's real `claude` least of all: a send's row stays in the
// queue, where the spec reads who sent it (the text the CLI would get and its sentBy).
const { DaemonConnection } = await import('../../../src/providers/daemon-connection.js')
const send = DaemonConnection.prototype.send
DaemonConnection.prototype.send = function (command, payload, ...rest) {
  if (command === 'start') throw new Error('automated-client fixture: no CLI starts here')
  return send.call(this, command, payload, ...rest)
}

// Two tasks, each with one stopped session, made the way the person's console makes them.
const sessions = ['7a1e0c55-1111-4000-8000-000000000001', '7a1e0c55-1111-4000-8000-000000000002']
const cwd = path.join(tmpBase, 'work')
await fs.mkdir(cwd, { recursive: true })
const { createSessionRecord, updateSessionRecord } = await import('../../../src/core/session-tracker.js')
const { linkSession } = await import('../../../src/core/task-manager.js')
const taskIds: string[] = []
for (const [i, sid] of sessions.entries()) {
  const created = await fetch(`${apiTarget}/api/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: `Automated client probe ${i + 1}`, project: 'Probe' }),
  })
  if (created.status !== 201) throw new Error(`fixture task: ${created.status} ${await created.text()}`)
  const taskId = ((await created.json()) as { task: { id: string } }).task.id
  taskIds.push(taskId)
  await createSessionRecord(sid, taskId, 'Probe', cwd)
  await updateSessionRecord(sid, { process_status: 'stopped', title: `Automated client probe ${i + 1}` })
  await linkSession(taskId, sid)
}

const { createServer: createViteServer } = await import('vite')
const { restateOwnOrigin } = await import('../../../web/dev-proxy-origin.js')
const { holdUntilWarm } = await import('./fixture-warm.js')
const warm = holdUntilWarm()
const viteServer = await createViteServer({
  root: path.join(repoRoot, 'web'),
  // Every request waits behind the SPA's first compile (fixture-warm.ts).
  plugins: [warm.plugin],
  // Its own dependency cache: a Vite that re-optimizes into a cache another run is serving
  // from hands the page two copies of React.
  cacheDir: path.join(tmpBase, 'vite-cache'),
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true, configure: (proxy) => restateOwnOrigin(proxy, apiTarget) },
      '/ws': { target: apiTarget.replace(/^http/, 'ws'), ws: true, configure: (proxy) => restateOwnOrigin(proxy, apiTarget) },
    },
  },
  logLevel: 'warn',
})
await viteServer.listen()
await warm.warm(viteServer)

console.log(`AUTOMATED_CLIENT_READY ${JSON.stringify({ port, apiPort: apiAddress.port, home: tmpBase, taskIds, sessions })}`)

const shutdown = async () => {
  await viteServer.close().catch(() => {})
  await stopServer()
  try {
    const { localDaemon } = await import('../../../src/providers/local-daemon.js')
    await localDaemon.stopIfIsolated()
  } catch { /* best effort */ }
  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
