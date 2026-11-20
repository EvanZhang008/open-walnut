/**
 * Fixture server for Plugin Store install modes (manifest `install`, see
 * src/core/plugins/store-install-mode.ts), on its own throwaway home.
 *
 * What it provisions:
 *   - `team-store`, a real git repo (file://) holding `team-auto` (`install: "auto"`) and
 *     `team-pick` (`install: "optional"`): what an install link points at.
 *   - `legacy-store`, a source an OLDER Walnut installed: configured, its clone on disk, no
 *     `installModes` in sources.json. Its `legacy-keep` plugin is marked `optional` by the
 *     store now, but the older Walnut had it loaded, so it must stay installed.
 *
 * Run: bun tests/e2e/browser/plugin-install-mode-server.ts
 * Reads PW_PLUGIN_STORE_PORT; prints `PLUGIN_STORE_READY <json>` when it is serving.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fixtureHome } from './fixture-home'

const port = Number(process.env.PW_PLUGIN_STORE_PORT ?? 3463)
const tmpBase = await fixtureHome(path.join(os.tmpdir(), `walnut-install-mode-${port}-${Date.now()}`))

// The data home BEFORE any server module loads (constants.ts reads it at import time).
process.env.OPEN_WALNUT_HOME = tmpBase
process.env.WALNUT_DAEMON_DIR = path.join(tmpBase, 'daemon')
process.env.WALNUT_STREAMS_DIR = path.join(tmpBase, 'daemon-streams')
process.env.WALNUT_DISABLE_SEARCH = '1'
process.env.WALNUT_DISABLE_BACKGROUND_AI = '1'
process.env.HOME = tmpBase
process.env.USERPROFILE = tmpBase
process.env.WALNUT_BUNDLED_STORE_DIR = path.join(tmpBase, 'bundled-store')
process.argv.push('--_ephemeral-child')

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

await fs.rm(tmpBase, { recursive: true, force: true })
await fs.mkdir(path.join(tmpBase, 'tasks'), { recursive: true })
await fs.mkdir(path.join(tmpBase, 'plugins'), { recursive: true })
await fs.mkdir(path.join(tmpBase, 'bundled-store'), { recursive: true })

async function writePlugin(baseDir: string, id: string, manifest: Record<string, unknown>): Promise<void> {
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

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete gitEnv[key]
function commitRepo(dir: string): void {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: gitEnv, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'store')
}

// The team store an install link points at.
const teamRepo = path.join(tmpBase, 'repos', 'team-store')
await writePlugin(teamRepo, 'team-auto', { name: 'Team Auto', description: 'Comes with the store.', install: 'auto' })
await writePlugin(teamRepo, 'team-pick', { name: 'Team Pick', description: 'Installed only when you pick it.', install: 'optional' })
commitRepo(teamRepo)
const teamUrl = `file://${teamRepo}`

// A source an older Walnut installed: cloned, configured, never sorted by install mode.
const legacyRepo = path.join(tmpBase, 'repos', 'legacy-store')
await writePlugin(legacyRepo, 'legacy-keep', { name: 'Legacy Keep', description: 'Installed before install modes existed.', install: 'optional' })
commitRepo(legacyRepo)
const legacyUrl = `file://${legacyRepo}`
await fs.mkdir(path.join(tmpBase, 'plugin-stores'), { recursive: true })
execFileSync('git', ['clone', '-q', legacyUrl, path.join(tmpBase, 'plugin-stores', 'legacy-store')], { env: gitEnv, stdio: 'ignore' })

const mockMainAgent = path.join(repoRoot, 'tests/providers/mock-main-agent.mjs')
await fs.writeFile(path.join(tmpBase, 'config.yaml'), JSON.stringify({
  version: 1,
  defaults: { priority: 'none', platform: 'local' },
  provider: { type: 'claude-code' },
  agent: { main_provider: 'store-cli', main_model: 'store-mock', triage: { debounce_minutes: 0 } },
  providers: { 'store-cli': { api: 'claude-cli', claude_cli_command: mockMainAgent } },
  plugin_sources: [{ url: legacyUrl }],
}, null, 2))
await fs.writeFile(path.join(tmpBase, 'tasks', 'tasks.json'), JSON.stringify({ version: 1, tasks: [] }, null, 2))

const { startServer, stopServer } = await import('../../../src/web/server.js')
const apiServer = await startServer({ port: 0, dev: true })
const apiAddress = apiServer.address()
if (!apiAddress || typeof apiAddress === 'string') throw new Error('Install mode fixture did not bind a TCP port')
const apiTarget = `http://127.0.0.1:${apiAddress.port}`

const { createServer: createViteServer } = await import('vite')
const { restateOwnOrigin } = await import('../../../web/dev-proxy-origin.js')
const { holdUntilWarm } = await import('./fixture-warm.js')
const warm = holdUntilWarm()
const viteServer = await createViteServer({
  root: path.join(repoRoot, 'web'),
  // Every request waits behind the SPA's first compile (fixture-warm.ts).
  plugins: [warm.plugin],
  cacheDir: path.join(tmpBase, 'vite-cache'),
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true, configure: (proxy) => restateOwnOrigin(proxy, apiTarget) },
      '/ws': { target: apiTarget.replace(/^http/, 'ws'), ws: true, configure: (proxy) => restateOwnOrigin(proxy, apiTarget.replace(/^http/, 'ws')) },
    },
  },
  logLevel: 'warn',
})
await viteServer.listen()
await warm.warm(viteServer)

const fixture = { port, home: tmpBase, teamUrl, legacyUrl }
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
