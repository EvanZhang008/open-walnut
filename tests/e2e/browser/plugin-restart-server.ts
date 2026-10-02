/**
 * Fixture server for plugin-app-visibility.spec.ts: a server that can be RESTARTED under an open
 * window, the way every deploy restarts :3456.
 *
 * Two roles, because the restart must not take the page's origin with it:
 *   - `api`  the real Walnut server on a fixed port, over a data home that survives restarts;
 *   - `vite` the SPA on its own port, proxying /api and /ws to the api port. It stays up while the
 *            api process is killed and started again, exactly like a browser tab across a deploy.
 *
 * The data home links:
 *   - `slow-boot-1` .. `slow-boot-3`, a chain of server plugins whose activate each waits
 *     PW_SLOW_BOOT_MS (under the 20 s activation limit), so the boot walk runs long enough for a
 *     reconnecting window to read it mid-walk;
 *   - `restart-demo`, a native web plugin with one Sidebar App. It depends on the end of the chain,
 *     so the walk reaches it only after every wait: until then it is missing from the lifecycle list.
 *
 * Plus `broken-demo`, a web plugin whose activate throws: its plugin row must say the App did not
 * load rather than show nothing.
 *
 * Never :3456 and never the developer's data: OPEN_WALNUT_HOME, HOME and the daemon dirs all point
 * inside PW_RESTART_HOME, which the spec removes.
 *
 * Run: PW_RESTART_ROLE=api|vite PW_RESTART_HOME=<dir> PW_RESTART_API_PORT=<n> [PW_RESTART_VITE_PORT=<n>]
 *      ./node_modules/.bin/tsx tests/e2e/browser/plugin-restart-server.ts
 * Prints `RESTART_API_READY <json>` / `RESTART_VITE_READY <json>` once serving.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

const role = process.env.PW_RESTART_ROLE
const home = process.env.PW_RESTART_HOME
const apiPort = Number(process.env.PW_RESTART_API_PORT)
if ((role !== 'api' && role !== 'vite') || !home || !Number.isInteger(apiPort) || apiPort <= 0) {
  throw new Error('plugin-restart-server needs PW_RESTART_ROLE, PW_RESTART_HOME and PW_RESTART_API_PORT')
}
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

/** Three waits in a row: one plugin may not take longer than 20 s to activate. */
const SLOW_BOOT_STEPS = 3

const SLOW_BOOT_SERVER = `export async function activate() {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.PW_SLOW_BOOT_MS || '6000')))
}
`

const RESTART_DEMO_WEB = `export async function activate(walnut) {
  function RestartDemo() { return null }
  walnut.ui.app({ id: 'main', title: 'Restart Demo', component: RestartDemo, placement: 'sidebar' })
}
`

const BROKEN_DEMO_WEB = `export async function activate() {
  throw new Error('Broken demo fixture: activation refused')
}
`

/** The first api start writes the home; every restart reuses it untouched. */
async function provision(dir: string): Promise<void> {
  try {
    await fs.access(path.join(dir, 'config.yaml'))
    return
  } catch { /* first start */ }
  await fs.mkdir(path.join(dir, 'tasks'), { recursive: true })
  const mockMainAgent = path.join(repoRoot, 'tests/providers/mock-main-agent.mjs')
  await fs.writeFile(path.join(dir, 'config.yaml'), JSON.stringify({
    version: 1,
    defaults: { priority: 'none', platform: 'local' },
    provider: { type: 'claude-code' },
    agent: { main_provider: 'restart-cli', main_model: 'restart-mock', triage: { debounce_minutes: 0 } },
    providers: { 'restart-cli': { api: 'claude-cli', claude_cli_command: mockMainAgent } },
  }, null, 2))
  await fs.writeFile(path.join(dir, 'tasks', 'tasks.json'), JSON.stringify({ version: 1, tasks: [] }, null, 2))

  for (let step = 1; step <= SLOW_BOOT_STEPS; step++) {
    const slow = path.join(dir, 'plugins', `slow-boot-${step}`)
    await fs.mkdir(slow, { recursive: true })
    await fs.writeFile(path.join(slow, 'manifest.json'), JSON.stringify({
      id: `slow-boot-${step}`, name: `Slow Boot ${step}`, description: 'Takes a while to start', version: '1.0.0',
      apiVersion: 1, engines: { walnut: '>=0.4.0' }, server: 'server.mjs',
      ...(step > 1 ? { dependencies: { [`slow-boot-${step - 1}`]: '^1.0.0' } } : {}),
    }, null, 2))
    await fs.writeFile(path.join(slow, 'server.mjs'), SLOW_BOOT_SERVER)
  }

  const demo = path.join(dir, 'plugins', 'restart-demo')
  await fs.mkdir(demo, { recursive: true })
  await fs.writeFile(path.join(demo, 'manifest.json'), JSON.stringify({
    id: 'restart-demo', name: 'Restart Demo', description: 'One Sidebar App', version: '1.0.0',
    apiVersion: 1, engines: { walnut: '>=0.4.0' }, web: 'web.mjs',
    dependencies: { [`slow-boot-${SLOW_BOOT_STEPS}`]: '^1.0.0' },
  }, null, 2))
  await fs.writeFile(path.join(demo, 'web.mjs'), RESTART_DEMO_WEB)

  const broken = path.join(dir, 'plugins', 'broken-demo')
  await fs.mkdir(broken, { recursive: true })
  await fs.writeFile(path.join(broken, 'manifest.json'), JSON.stringify({
    id: 'broken-demo', name: 'Broken Demo', description: 'A web build that refuses to start', version: '1.0.0',
    apiVersion: 1, engines: { walnut: '>=0.4.0' }, web: 'web.mjs',
  }, null, 2))
  await fs.writeFile(path.join(broken, 'web.mjs'), BROKEN_DEMO_WEB)
}

if (role === 'api') {
  // Set the data home BEFORE importing any server module: constants.ts resolves it at import time.
  process.env.OPEN_WALNUT_HOME = home
  process.env.WALNUT_DAEMON_DIR = path.join(home, 'daemon')
  process.env.WALNUT_STREAMS_DIR = path.join(home, 'daemon-streams')
  process.env.WALNUT_DISABLE_SEARCH = '1'
  process.env.WALNUT_DISABLE_BACKGROUND_AI = '1'
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.argv.push('--_ephemeral-child')
  await provision(home)

  const { startServer, stopServer } = await import('../../../src/web/server.js')
  await startServer({ port: apiPort, dev: true })
  console.log(`RESTART_API_READY ${JSON.stringify({ apiPort, home })}`)

  const shutdown = async () => {
    await stopServer().catch(() => {})
    try {
      const { localDaemon } = await import('../../../src/providers/local-daemon.js')
      await localDaemon.stopIfIsolated()
    } catch { /* best effort */ }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
} else {
  const vitePort = Number(process.env.PW_RESTART_VITE_PORT)
  if (!Number.isInteger(vitePort) || vitePort <= 0) throw new Error('the vite role needs PW_RESTART_VITE_PORT')
  const apiTarget = `http://127.0.0.1:${apiPort}`
  const { createServer: createViteServer } = await import('vite')
  const { restateOwnOrigin } = await import('../../../web/dev-proxy-origin.js')
  const viteServer = await createViteServer({
    root: path.join(repoRoot, 'web'),
    // Scan every source file for dependencies at startup. Vite's on-demand discovery FULL-PAGE-
    // RELOADS when a lazily loaded module brings a new one mid-session, and a reload during the
    // restart erases exactly what the spec watches (the open window's state).
    optimizeDeps: { entries: ['index.html', 'src/**/*.{ts,tsx}'] },
    server: {
      host: '127.0.0.1',
      port: vitePort,
      strictPort: true,
      proxy: {
        // restateOwnOrigin: the server trusts only its own Origin (web/dev-proxy-origin.ts).
        '/api': { target: apiTarget, changeOrigin: true, configure: (proxy) => restateOwnOrigin(proxy, apiTarget) },
        '/ws': { target: apiTarget.replace(/^http/, 'ws'), ws: true, configure: (proxy) => restateOwnOrigin(proxy, apiTarget) },
      },
    },
    logLevel: 'warn',
  })
  await viteServer.listen()
  console.log(`RESTART_VITE_READY ${JSON.stringify({ vitePort })}`)
  const shutdown = async () => {
    await viteServer.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
