/**
 * Fixture server for editing hidden secrets in Settings: a plugin's settings
 * form (lists of secret keys, a URL with a password), the tunnel options form
 * (Phones & Cloud, Open from a browser) and the host server tunnel form
 * (Remote hosts, Walnut on a host).
 *
 * Two fixture plugins written into a throwaway home's plugins/ dir: `acmeform`,
 * whose manifest declares the settings form and whose server registers a tunnel
 * provider with three options, and `acmetunnelb`, a second tunnel provider (two
 * options, one of them shared), so the tunnel forms show a provider switch. The
 * stored values are fakes. The tunnel is off, so nothing runs. The one host entry is turned off and its name does not
 * resolve: no connection to it is ever made (a host server only starts once the
 * host's daemon connects), so its tunnel form edits settings and nothing more.
 *
 * Never :3456 and never the developer's data: OPEN_WALNUT_HOME, HOME and the
 * daemon dirs all point inside one temp directory that is removed on shutdown.
 *
 * Run: bun tests/e2e/browser/plugin-secret-form-server.ts
 * Reads PW_PLUGIN_SECRET_FORM_PORT; prints `PLUGIN_SECRET_FORM_READY <json>` when serving.
 */

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fixtureHome } from './fixture-home'

const port = Number(process.env.PW_PLUGIN_SECRET_FORM_PORT ?? 3464)
// Its own home for real: Bun reads HOME only at startup (fixture-home.ts).
const tmpBase = await fixtureHome(path.join(os.tmpdir(), `walnut-plugin-secret-form-${port}-${Date.now()}`))

process.env.OPEN_WALNUT_HOME = tmpBase
process.env.WALNUT_DAEMON_DIR = path.join(tmpBase, 'daemon')
process.env.WALNUT_STREAMS_DIR = path.join(tmpBase, 'daemon-streams')
process.env.WALNUT_DISABLE_SEARCH = '1'
process.env.WALNUT_DISABLE_BACKGROUND_AI = '1'
process.env.HOME = tmpBase
process.env.USERPROFILE = tmpBase
process.argv.push('--_ephemeral-child')

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

const PLUGIN_ID = 'acmeform'
/** The stored values: fakes, each findable by its own label. */
const SEEDED = {
  enabled: true,
  region: 'us-west-2',
  database_url: 'postgres://acme:form-db-pw@db1.acme.invalid:5432/acme',
  api_keys: ['sk-form-one-1111', 'sk-form-two-2222'],
  // Entries no tail tells apart: two with the same last 4, one with a comma in its last 4. One shows its tail.
  backup_keys: ['bk-form-dup-a-AB12', 'bk-form-dup-b-AB12', 'bk-form-comma-c,dd', 'bk-form-solo-7777'],
  // Two with the same last 4, the first with a comma in it: both bullets only.
  pair_keys: ['pk-form-a,b-QZ12', 'pk-form-cd-QZ12'],
  // Three with their own tails, for typing next to a hidden line.
  ring_keys: ['rk-form-one-1111', 'rk-form-two-2222', 'rk-form-three-3333'],
}
const TUNNEL_B = 'acmetunnelb'
const EXPOSE = { enabled: false, provider: 'acme-tunnel', options: { name: 'alpha', endpoint: 'https://acme:form-tunnel-pw@t1.acme.invalid/', token: 'tok-form-9999' } }
const HOSTS = {
  'acme-box': {
    hostname: 'acme-box.invalid', enabled: false, label: 'Acme box',
    server: { enabled: true, expose: { enabled: false, provider: 'acme-tunnel', options: { name: 'hostalpha', endpoint: 'https://acme:form-host-pw@ht1.acme.invalid/', token: 'tok-form-host-7777' } } },
  },
}

const { sweepStaleTmpDirs, writeOwnerPid } = await import('../../setup/stale-tmp.js')
sweepStaleTmpDirs([{ prefix: 'walnut-plugin-secret-form-', name: /^walnut-plugin-secret-form-\d+-\d+$/, pidFrom: 'owner-file' }])
await fs.rm(tmpBase, { recursive: true, force: true })
await fs.mkdir(path.join(tmpBase, 'tasks'), { recursive: true })
writeOwnerPid(tmpBase)
await fs.mkdir(path.join(tmpBase, 'plugins', PLUGIN_ID, 'dist'), { recursive: true })

const mockMainAgent = path.join(repoRoot, 'tests/providers/mock-main-agent.mjs')
/** The whole config as seeded; the spec writes it back before each test, so each one starts from it. */
const SEED = {
  version: 1,
  defaults: { priority: 'none', platform: 'local' },
  provider: { type: 'claude-code' },
  agent: { main_provider: 'form-cli', main_model: 'form-mock', triage: { debounce_minutes: 0 } },
  providers: { 'form-cli': { api: 'claude-cli', claude_cli_command: mockMainAgent } },
  plugins: { [PLUGIN_ID]: SEEDED, [TUNNEL_B]: { enabled: true } },
  expose: EXPOSE,
  hosts: HOSTS,
}
await fs.writeFile(path.join(tmpBase, 'config.yaml'), JSON.stringify(SEED, null, 2))
await fs.writeFile(path.join(tmpBase, 'tasks', 'tasks.json'), JSON.stringify({ version: 1, tasks: [] }, null, 2))

await fs.writeFile(path.join(tmpBase, 'plugins', PLUGIN_ID, 'manifest.json'), JSON.stringify({
  id: PLUGIN_ID,
  name: 'Acme Form',
  description: 'A fixture plugin with hidden secrets in its settings form.',
  version: '1.0.0',
  apiVersion: 1,
  engines: { walnut: '>=0.0.0' },
  server: 'dist/server.mjs',
  configSchema: {
    type: 'object',
    properties: {
      region: { type: 'string' },
      database_url: { type: 'string' },
      api_keys: { type: 'array', items: { type: 'string' } },
      backup_keys: { type: 'array', items: { type: 'string' } },
      pair_keys: { type: 'array', items: { type: 'string' } },
      ring_keys: { type: 'array', items: { type: 'string' } },
    },
  },
  uiHints: {
    region: { label: 'Region' },
    database_url: { label: 'Database URL' },
    api_keys: { label: 'API keys' },
    backup_keys: { label: 'Backup keys' },
    pair_keys: { label: 'Pair keys' },
    ring_keys: { label: 'Ring keys' },
  },
}, null, 2))
await fs.writeFile(path.join(tmpBase, 'plugins', PLUGIN_ID, 'dist', 'server.mjs'), `
export function activate(walnut) {
  walnut.expose.register({
    id: 'acme-tunnel', title: 'Acme Tunnel', command: '/usr/bin/false', args: ['{port}'],
    options: [{ key: 'name', label: 'Tunnel name' }, { key: 'endpoint', label: 'Endpoint' }, { key: 'token', label: 'Token' }],
    urlPattern: 'https://[a-z0-9.-]+\\\\.acme\\\\.invalid',
  })
}
export function deactivate() {}
`)
await fs.mkdir(path.join(tmpBase, 'plugins', TUNNEL_B, 'dist'), { recursive: true })
await fs.writeFile(path.join(tmpBase, 'plugins', TUNNEL_B, 'manifest.json'), JSON.stringify({
  id: TUNNEL_B,
  name: 'Acme Tunnel B',
  description: 'A second fixture tunnel provider.',
  version: '1.0.0',
  apiVersion: 1,
  engines: { walnut: '>=0.0.0' },
  server: 'dist/server.mjs',
}, null, 2))
await fs.writeFile(path.join(tmpBase, 'plugins', TUNNEL_B, 'dist', 'server.mjs'), `
export function activate(walnut) {
  walnut.expose.register({
    id: 'acme-tunnel-b', title: 'Acme Tunnel B', command: '/usr/bin/false', args: ['{port}'],
    options: [{ key: 'endpoint', label: 'Endpoint' }, { key: 'region', label: 'Region' }],
    urlPattern: 'https://[a-z0-9.-]+\\\\.acme\\\\.invalid',
  })
}
export function deactivate() {}
`)

const { startServer, stopServer } = await import('../../../src/web/server.js')
const apiServer = await startServer({ port: 0, dev: true })
const apiAddress = apiServer.address()
if (!apiAddress || typeof apiAddress === 'string') throw new Error('Plugin secret form fixture did not bind a TCP port')
const apiTarget = `http://127.0.0.1:${apiAddress.port}`

const { createServer: createViteServer } = await import('vite')
const { restateOwnOrigin } = await import('../../../web/dev-proxy-origin.js')
const viteServer = await createViteServer({
  root: path.join(repoRoot, 'web'),
  // Its own dependency cache: a re-optimize in a shared one mid-run loads two Reacts.
  cacheDir: path.join(tmpBase, 'vite-cache'),
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    proxy: {
      // The page's own origin restated, or the cross-site guard refuses every write.
      '/api': { target: apiTarget, changeOrigin: true, configure: (proxy) => restateOwnOrigin(proxy, apiTarget) },
      '/ws': { target: apiTarget.replace(/^http/, 'ws'), ws: true, configure: (proxy) => restateOwnOrigin(proxy, apiTarget) },
    },
  },
  logLevel: 'warn',
})
await viteServer.listen()

const fixture = { port, home: tmpBase, pluginId: PLUGIN_ID, configFile: path.join(tmpBase, 'config.yaml'), seed: SEED, seeded: SEEDED, expose: EXPOSE, hosts: HOSTS }
console.log(`PLUGIN_SECRET_FORM_READY ${JSON.stringify(fixture)}`)

let shuttingDown = false
const shutdown = async () => {
  // SIGTERM may arrive more than once (a runner, a process group); one teardown, not two.
  if (shuttingDown) return
  shuttingDown = true
  const teardown = (async () => {
    await viteServer.close().catch(() => {})
    await stopServer()
    try {
      const { localDaemon } = await import('../../../src/providers/local-daemon.js')
      await localDaemon.stopIfIsolated()
    } catch { /* best effort */ }
  })()
  await Promise.race([teardown.catch(() => {}), new Promise((r) => setTimeout(r, 8_000))])
  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
// The same two competing SIGTERM handlers plugin-connection-server.ts unhooks.
const { armGracefulSignalExit } = await import('../../../src/web/server.js')
armGracefulSignalExit()
for (const l of process.listeners('SIGTERM')) if (l.name === 'parentSigtermCallback') process.off('SIGTERM', l)
for (const l of process.stdin.listeners('end')) if (l.name === 'parentSigtermCallback') process.stdin.off('end', l)
process.on('exit', () => {
  try { fsSync.rmSync(tmpBase, { recursive: true, force: true, maxRetries: 3 }) } catch { /* best effort */ }
})
