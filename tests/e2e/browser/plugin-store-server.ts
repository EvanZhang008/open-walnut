/**
 * Fixture server for Settings → Plugins (the registry store).
 *
 * Its own server, not the shared :3457 fixture, for the documented reason: that
 * fixture installs no plugins on purpose (a spec there asserts a stock install has
 * zero app entries), and a store with nothing in it cannot demonstrate a store.
 *
 * What it provisions in a throwaway home:
 *   - walnut-time linked into `plugins/` exactly the way `walnut-plugin link` writes
 *     it, so the Installed list has a real plugin with a real App to lose.
 *   - `alpha`, plus `beta` and `delta` which both declare `dependencies: { alpha: '^1' }`,
 *     so the store has a real dependency to break: an OFF on alpha is refused until the
 *     user agrees, and both dependents must come back on their own when alpha does. TWO
 *     dependents on purpose: each blocked row offers its own "Turn on Alpha", and one
 *     shared test id across rows would make the second one unclickable. They register
 *     nothing, so nothing else in the app moves.
 *   - a USER catalog overlay (`plugin-registry.json` in the data home) adding one git
 *     entry, so the Available list has an entry whose Install button prefills the
 *     real install form (nothing installs it: the point is that the trust checkbox
 *     still gates the Add button), plus `gamma`, a git entry that `requires` alpha, so
 *     an available row can say what installing it would also pull in, plus `zeta`, the
 *     entry `epsilon` waits for.
 *   - `epsilon`, a plugin inside a source clone that waits on `zeta`, so a blocked row
 *     can offer an install and prove that the offer ASKS first.
 *
 * Never :3456 and never the developer's data: OPEN_WALNUT_HOME, HOME and the daemon
 * dirs all point inside one temp directory that is removed on shutdown.
 *
 * Run: ./node_modules/.bin/tsx tests/e2e/browser/plugin-store-server.ts
 * Reads PW_PLUGIN_STORE_PORT; prints `PLUGIN_STORE_READY <json>` when it is serving.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const port = Number(process.env.PW_PLUGIN_STORE_PORT ?? 3462)
const tmpBase = path.join(os.tmpdir(), `walnut-plugin-store-${port}-${Date.now()}`)

// Set the data home BEFORE importing any server module: constants.ts resolves it at
// import time. `--_ephemeral-child` on argv is what stops the leaked-tmpdir guard from
// pulling it back to ~/.open-walnut, and nothing can inherit it.
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

/**
 * A configured plugin source whose clone already exists on disk (see `epsilon` below).
 * Nothing is ever fetched from it; `slugForUrl` derives the directory name, which is why
 * the clone dir and this URL have to agree.
 */
const dependencySourceUrl = 'https://example.invalid/epsilon-pack.git'
const dependencySourceSlug = 'epsilon-pack'

// No live model calls from a fixture: the main agent points at the repo's mock CLI.
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
  plugin_sources: [{ url: dependencySourceUrl }],
}, null, 2))

await fs.writeFile(path.join(tmpBase, 'tasks', 'tasks.json'), JSON.stringify({ version: 1, tasks: [] }, null, 2))

/**
 * The user catalog overlay. A git entry here is what proves the Available → Install
 * path prefills the existing form; it is never fetched, so the URL can be anything
 * the parser accepts.
 */
const overlayEntryId = 'store-fixture-plugin'
const requiresEntryId = 'gamma'
await fs.writeFile(path.join(tmpBase, 'plugin-registry.json'), JSON.stringify({
  version: 1,
  plugins: [
    {
      id: overlayEntryId,
      name: 'Store Fixture Plugin',
      description: 'A catalog entry that is not installed, used to exercise the Install prefill.',
      adds: ['App'],
      source: { kind: 'git', url: 'https://example.invalid/store-fixture-plugin.git' },
    },
    {
      // Describes a dependency it never installs: the row says "Also needs: Alpha"
      // whenever alpha is not running, and installing gamma is still a separate yes.
      id: requiresEntryId,
      name: 'Gamma',
      description: 'A catalog entry that needs another plugin.',
      source: { kind: 'git', url: 'https://example.invalid/gamma.git' },
      requires: { alpha: '^1' },
    },
    {
      // What `epsilon` is waiting for. It is in the catalog and NOT on this machine, so
      // epsilon's blocked row can offer an install — through the consent list.
      id: 'zeta',
      name: 'Zeta',
      description: 'A catalog entry another plugin depends on.',
      source: { kind: 'git', url: 'https://example.invalid/zeta.git' },
    },
  ],
}, null, 2))

/**
 * Linked plugins with a real dependency edge. They activate and register nothing: the
 * store's dependency behaviour is the subject, so anything else they contributed would be
 * a second variable in every assertion.
 */
async function writeFixturePlugin(
  id: string,
  manifest: Record<string, unknown>,
  baseDir = path.join(tmpBase, 'plugins'),
): Promise<void> {
  const dir = path.join(baseDir, id)
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true })
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id,
    version: '1.0.0',
    apiVersion: 1,
    engines: { walnut: '>=0.0.0' },
    server: 'dist/server.mjs',
    ...manifest,
  }, null, 2))
  await fs.writeFile(path.join(dir, 'dist', 'server.mjs'), 'export function activate() {}\nexport function deactivate() {}\n')
}

await writeFixturePlugin('alpha', { name: 'Alpha' })
await writeFixturePlugin('beta', { name: 'Beta', dependencies: { alpha: '^1' } })
await writeFixturePlugin('delta', { name: 'Delta', dependencies: { alpha: '^1' } })

/**
 * A plugin that came from a SOURCE (a clone dir under plugin-stores/, exactly the shape
 * `POST /api/plugin-sources` leaves behind) and waits on a dependency only the catalog
 * can supply. That combination is what puts an "Install Zeta…" button on a blocked row,
 * and the button opens the consent list rather than cloning: a catalog file naming a URL
 * is not the user agreeing to run its code. Nothing is ever fetched — the test stops at
 * the consent panel, which is the whole point of it existing.
 */
await writeFixturePlugin(
  'epsilon',
  { name: 'Epsilon', dependencies: { zeta: '^1' } },
  path.join(tmpBase, 'plugin-stores', dependencySourceSlug),
)

// Install walnut-time the documented author way: a symlink in the data home's
// plugins/ directory, which is exactly what `walnut-plugin link` writes.
const pluginSource = path.join(repoRoot, 'examples/plugins/walnut-time')
await fs.access(path.join(pluginSource, 'dist', 'web.mjs'))
await fs.symlink(pluginSource, path.join(tmpBase, 'plugins', 'walnut-time'), 'dir')

const { startServer, stopServer } = await import('../../../src/web/server.js')
const apiServer = await startServer({ port: 0, dev: true })
const apiAddress = apiServer.address()
if (!apiAddress || typeof apiAddress === 'string') throw new Error('Plugin store fixture did not bind a TCP port')
const apiTarget = `http://127.0.0.1:${apiAddress.port}`

const { createServer: createViteServer } = await import('vite')
const viteServer = await createViteServer({
  root: path.join(repoRoot, 'web'),
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/ws': { target: apiTarget.replace(/^http/, 'ws'), ws: true },
    },
  },
  logLevel: 'warn',
})
await viteServer.listen()

const fixture = {
  port,
  home: tmpBase,
  overlayEntryId,
  requiresEntryId,
  dependencySourceSlug,
  dependencySourceUrl,
}
await fs.writeFile(path.join(tmpBase, 'fixture.json'), JSON.stringify(fixture, null, 2))
console.log(`PLUGIN_STORE_READY ${JSON.stringify(fixture)}`)

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
