/**
 * Fixture server for the rail's plugin status items (walnut.ui.statusItem).
 *
 * Its own server, not the shared :3457 fixture, because that one installs no plugins by
 * design and a status item only exists when a plugin publishes one.
 *
 * What it provisions in a throwaway home:
 *   - `probe`, a hand-written plugin whose ops set, clear and change its item, so the
 *     spec can drive every shape the host draws (tones, glyphs, timers, a failing
 *     button, a slow one) without waiting on a real clock. It publishes "Probe ready" on
 *     activate, so a reload is visible. Its App proves the popover's footer link.
 *   - Rhythm, linked from the repo's bundled store with the macOS parts OFF (no file
 *     under ~/Library is read, no process started), so the real plugin's focus ring is
 *     on the same rail.
 *
 * Never :3456 and never the developer's data: OPEN_WALNUT_HOME, HOME and the daemon dirs
 * all point inside one temp directory that is removed on shutdown.
 *
 * Run: ./node_modules/.bin/tsx tests/e2e/browser/status-items-server.ts
 * Reads PW_STATUS_ITEMS_PORT; prints `STATUS_ITEMS_READY <json>` when it is serving.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const port = Number(process.env.PW_STATUS_ITEMS_PORT ?? 3463)
const tmpBase = path.join(os.tmpdir(), `walnut-status-items-${port}-${Date.now()}`)

// Before any server import: constants.ts resolves the data home at import time.
process.env.OPEN_WALNUT_HOME = tmpBase
process.env.WALNUT_DAEMON_DIR = path.join(tmpBase, 'daemon')
process.env.WALNUT_STREAMS_DIR = path.join(tmpBase, 'daemon-streams')
process.env.WALNUT_DISABLE_SEARCH = '1'
process.env.WALNUT_DISABLE_BACKGROUND_AI = '1'
process.env.HOME = tmpBase
process.env.USERPROFILE = tmpBase
// An empty bundled store: Rhythm is linked below, and must not also list as bundled.
process.env.WALNUT_BUNDLED_STORE_DIR = path.join(tmpBase, 'bundled-store')
process.argv.push('--_ephemeral-child')

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

await fs.rm(tmpBase, { recursive: true, force: true })
await fs.mkdir(path.join(tmpBase, 'tasks'), { recursive: true })
await fs.mkdir(path.join(tmpBase, 'plugins', 'probe', 'dist'), { recursive: true })
await fs.mkdir(path.join(tmpBase, 'bundled-store'), { recursive: true })

const mockMainAgent = path.join(repoRoot, 'tests/providers/mock-main-agent.mjs')
await fs.writeFile(path.join(tmpBase, 'config.yaml'), JSON.stringify({
  version: 1,
  defaults: { priority: 'none', platform: 'local' },
  provider: { type: 'claude-code' },
  agent: {
    main_provider: 'store-cli',
    main_model: 'store-mock',
    triage: { debounce_minutes: 0 },
  },
  providers: { 'store-cli': { api: 'claude-cli', claude_cli_command: mockMainAgent } },
  plugins: {
    'walnut-rhythm': { mirror_macos_focus: false, macos_focus_shortcuts: false, quiet_hours: '' },
  },
}, null, 2))
await fs.writeFile(path.join(tmpBase, 'tasks', 'tasks.json'), JSON.stringify({ version: 1, tasks: [] }, null, 2))

const probeDir = path.join(tmpBase, 'plugins', 'probe')
await fs.writeFile(path.join(probeDir, 'manifest.json'), JSON.stringify({
  id: 'probe',
  name: 'Probe',
  version: '1.0.0',
  apiVersion: 1,
  engines: { walnut: '>=0.0.0' },
  server: 'dist/server.mjs',
  web: 'dist/web.mjs',
}, null, 2))
await fs.writeFile(path.join(probeDir, 'dist', 'server.mjs'), `
export function activate(walnut) {
  const item = walnut.ui.statusItem({ id: 'probe', order: 100 })
  const op = (name, handler, properties = {}) => walnut.registry.op({
    name, title: name, description: 'Status item probe: ' + name, readonly: false, remote: 'deny',
    inputSchema: { type: 'object', properties }, handler,
  })
  let acks = 0
  op('show', async (args) => { item.set(args.state); return { shown: true } }, { state: { type: 'object' } })
  op('hide', async () => { item.clear(); return { hidden: true } })
  op('ack', async () => {
    acks += 1
    item.set({ title: 'Acknowledged ' + acks, tone: 'success', glyph: 'check', actions: [{ label: 'Again', op: 'ack', primary: true }] })
    return { acks }
  })
  op('refuse', async () => { throw new Error('Probe refused on purpose') })
  op('slow', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    item.set({ title: 'Slow one finished', tone: 'neutral' })
    return {}
  })
  item.set({ title: 'Probe ready', detail: 'Published on activate.', tone: 'neutral' })
}
export function deactivate() {}
`)
await fs.writeFile(path.join(probeDir, 'dist', 'web.mjs'), `
export function activate(walnut) {
  const h = globalThis.__WALNUT_PLUGIN_HOST__.React.createElement
  walnut.ui.app({ id: 'main', title: 'Probe', component: () => h('main', { 'data-testid': 'probe-app' }, h('h1', null, 'Probe page')) })
}
`)

// Rhythm, linked the way `walnut-plugin link` writes it. Its dist must be built.
const rhythmSource = path.join(repoRoot, 'plugin-store/walnut-rhythm')
await fs.access(path.join(rhythmSource, 'dist', 'server.mjs'))
await fs.symlink(rhythmSource, path.join(tmpBase, 'plugins', 'walnut-rhythm'), 'dir')

const { startServer, stopServer } = await import('../../../src/web/server.js')
const apiServer = await startServer({ port: 0, dev: true })
const apiAddress = apiServer.address()
if (!apiAddress || typeof apiAddress === 'string') throw new Error('Status items fixture did not bind a TCP port')
const apiTarget = `http://127.0.0.1:${apiAddress.port}`

const { createServer: createViteServer } = await import('vite')
const { restateOwnOrigin } = await import('../../../web/dev-proxy-origin.js')
const viteServer = await createViteServer({
  root: path.join(repoRoot, 'web'),
  // Its own dependency cache: a Vite that re-optimizes into a cache another run is serving
  // from hands the page two copies of React ("reading 'useContext'" of null).
  cacheDir: path.join(tmpBase, 'vite-cache'),
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    proxy: {
      // The server trusts only its own Origin: without this the page's POSTs and its
      // WebSocket are refused as cross-site, and no live update ever arrives.
      '/api': { target: apiTarget, changeOrigin: true, configure: (proxy) => restateOwnOrigin(proxy, apiTarget) },
      '/ws': { target: apiTarget.replace(/^http/, 'ws'), ws: true, configure: (proxy) => restateOwnOrigin(proxy, apiTarget) },
    },
  },
  logLevel: 'warn',
})
await viteServer.listen()

const fixture = { port, apiPort: apiAddress.port, home: tmpBase }
console.log(`STATUS_ITEMS_READY ${JSON.stringify(fixture)}`)

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
