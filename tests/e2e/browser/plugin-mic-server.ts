/**
 * Fixture server for plugin dictation (`walnut.ui.views.MicButton`, plugin-mic.spec.ts).
 *
 * Its own server, not the shared :3457 fixture, because the shared fixture installs no
 * plugins by design. This one LINKS the hand-written fixture plugin
 * (fixtures/plugin-mic-plugin: a text box with the host's mic beside it) into a
 * throwaway data home and starts the real server with Vite in front. The voice engine
 * is the spec's: it answers the STT routes in the page.
 *
 * Never :3456 and never the developer's data: OPEN_WALNUT_HOME, HOME and the daemon
 * dirs all point inside one temp directory that is removed on shutdown.
 *
 * Reads PW_PLUGIN_MIC_PORT; prints `PLUGIN_MIC_READY <json>` when it is serving.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fixtureHome } from './fixture-home'

const port = Number(process.env.PW_PLUGIN_MIC_PORT ?? 3462)
// Its own home for real: Bun reads HOME only at startup (fixture-home.ts).
const tmpBase = await fixtureHome(path.join(os.tmpdir(), `walnut-plugin-mic-${port}-${Date.now()}`))

process.env.OPEN_WALNUT_HOME = tmpBase
process.env.WALNUT_DAEMON_DIR = path.join(tmpBase, 'daemon')
process.env.WALNUT_STREAMS_DIR = path.join(tmpBase, 'daemon-streams')
process.env.WALNUT_DISABLE_SEARCH = '1'
process.env.WALNUT_DISABLE_BACKGROUND_AI = '1'
process.env.HOME = tmpBase
process.env.USERPROFILE = tmpBase
process.argv.push('--_ephemeral-child')

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

await fs.rm(tmpBase, { recursive: true, force: true })
await fs.mkdir(path.join(tmpBase, 'tasks'), { recursive: true })
await fs.mkdir(path.join(tmpBase, 'plugins'), { recursive: true })

const mockMainAgent = path.join(repoRoot, 'tests/providers/mock-main-agent.mjs')
await fs.writeFile(path.join(tmpBase, 'config.yaml'), JSON.stringify({
  version: 1,
  defaults: { priority: 'none', platform: 'local' },
  provider: { type: 'claude-code' },
  agent: {
    main_provider: 'plugin-mic-cli',
    main_model: 'plugin-mic-mock',
    triage: { debounce_minutes: 0 },
  },
  providers: { 'plugin-mic-cli': { api: 'claude-cli', claude_cli_command: mockMainAgent } },
}, null, 2))
await fs.writeFile(path.join(tmpBase, 'tasks', 'tasks.json'), JSON.stringify({ version: 1, tasks: [] }, null, 2))

// Installed the documented author way: a symlink in the data home's plugins/ directory,
// which is exactly what `walnut-plugin link` writes.
await fs.symlink(
  path.join(repoRoot, 'tests/e2e/browser/fixtures/plugin-mic-plugin'),
  path.join(tmpBase, 'plugins', 'plugin-mic-fixture'),
  'dir',
)

const { startServer, stopServer } = await import('../../../src/web/server.js')
const apiServer = await startServer({ port: 0, dev: true })
const apiAddress = apiServer.address()
if (!apiAddress || typeof apiAddress === 'string') throw new Error('Plugin mic fixture did not bind a TCP port')
const apiTarget = `http://127.0.0.1:${apiAddress.port}`

const { createServer: createViteServer } = await import('vite')
// See time-app-server.ts: the proxy restates its own pages' origin as the API target.
const { restateOwnOrigin } = await import('../../../web/dev-proxy-origin.js')
const viteServer = await createViteServer({
  root: path.join(repoRoot, 'web'),
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

console.log(`PLUGIN_MIC_READY ${JSON.stringify({ port, home: tmpBase })}`)

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
