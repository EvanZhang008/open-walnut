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
 * PW_PLUGIN_FIXTURE=session links fixtures/plugin-session-plugin instead (an App
 * hosting a SessionView, plugin-session-fullscreen.spec.ts) and seeds the sessions
 * it and the home page show. PW_PLUGIN_FIXTURE=session-pane links
 * fixtures/plugin-session-pane-plugin (Apps with a pane beside a session's chat,
 * session-app-pane.spec.ts) with the same sessions. PW_PLUGIN_FIXTURE=drawing links the
 * bundled Drawing plugin (plugin-store/walnut-drawing, built first when its dist is missing or
 * stale) with the drawing_app and apps_stay_open experiments on, and runs sessions on the repo's
 * mock CLI (drawing-app-integration.spec.ts, drawing-composer.spec.ts).
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fixtureHome } from './fixture-home'
import { ensureDrawingPluginBuilt } from './drawing-plugin-build'

const port = Number(process.env.PW_PLUGIN_MIC_PORT ?? 3462)
// Its own home for real: Bun reads HOME only at startup (fixture-home.ts).
const tmpBase = await fixtureHome(path.join(os.tmpdir(), `walnut-plugin-mic-${port}-${Date.now()}`))

process.env.OPEN_WALNUT_HOME = tmpBase
process.env.WALNUT_DAEMON_DIR = path.join(tmpBase, 'daemon')
process.env.WALNUT_STREAMS_DIR = path.join(tmpBase, 'daemon-streams')
process.env.WALNUT_DISABLE_SEARCH = '1'
process.env.WALNUT_DISABLE_BACKGROUND_AI = '1'
// Approvals ask, as before the switch (src/core/approvals/ask-me.ts): the specs check the cards.
process.env.WALNUT_APPROVALS_ASK ??= '1'
process.env.HOME = tmpBase
process.env.USERPROFILE = tmpBase
process.argv.push('--_ephemeral-child', '--_own-accounts')

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

await fs.rm(tmpBase, { recursive: true, force: true })
await fs.mkdir(path.join(tmpBase, 'tasks'), { recursive: true })
await fs.mkdir(path.join(tmpBase, 'plugins'), { recursive: true })

const drawingFixture = process.env.PW_PLUGIN_FIXTURE === 'drawing'
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
  ...(drawingFixture ? { experimental: { drawing_app: true, apps_stay_open: true }, plugins: { 'walnut-drawing': { enabled: true } } } : {}),
}, null, 2))
const paneFixture = process.env.PW_PLUGIN_FIXTURE === 'session-pane'
const sessionFixture = process.env.PW_PLUGIN_FIXTURE === 'session' || paneFixture
const fixtureDir = (dir: string) => path.join(repoRoot, 'tests/e2e/browser/fixtures', dir)
const fixturePlugin = drawingFixture
  ? { source: await ensureDrawingPluginBuilt(repoRoot), id: 'walnut-drawing' }
  : paneFixture
    ? { source: fixtureDir('plugin-session-pane-plugin'), id: 'plugin-session-pane-fixture' }
    : sessionFixture
      ? { source: fixtureDir('plugin-session-plugin'), id: 'plugin-session-fixture' }
      : { source: fixtureDir('plugin-mic-plugin'), id: 'plugin-mic-fixture' }
const now = new Date().toISOString()
// Two stopped sessions with their tasks: one for the plugin's SessionView, one for a home column.
const seeded = sessionFixture ? [
  { task: 'pw-task-plugin-session', session: 'pw-plugin-session', title: 'Plugin practice round' },
  { task: 'pw-task-home-session', session: 'pw-home-session', title: 'Home column round' },
] : []
await fs.writeFile(path.join(tmpBase, 'tasks', 'tasks.json'), JSON.stringify({
  version: 1,
  tasks: seeded.map((s) => ({
    id: s.task, title: s.title, status: 'in_progress', phase: 'IN_PROGRESS', priority: 'none',
    project: 'Walnut', source: 'local', session_ids: [s.session], active_session_ids: [],
    session_id: s.session, session_status: { process_status: 'stopped', mode: 'bypass' },
    created_at: now, updated_at: now, description: '', summary: '', note: '', subtasks: [],
  })),
}, null, 2))
if (sessionFixture) {
  await fs.writeFile(path.join(tmpBase, 'sessions.json'), JSON.stringify({
    version: 2,
    sessions: seeded.map((s) => ({
      claudeSessionId: s.session, taskId: s.task, project: 'Walnut', process_status: 'stopped',
      mode: 'bypass', last_status_change: now, startedAt: now, lastActiveAt: now, messageCount: 1,
      cwd: repoRoot, title: s.title,
    })),
  }, null, 2))
}

// Installed the documented author way: a symlink in the data home's plugins/ directory,
// which is exactly what `walnut-plugin link` writes.
await fs.symlink(fixturePlugin.source, path.join(tmpBase, 'plugins', fixturePlugin.id), 'dir')

if (drawingFixture) {
  // The drawing specs start real sessions (a task's composer, a session beside the Drawing App):
  // the repo's mock CLI answers them, through the same two seams as test-server.ts (the runner's
  // command, and the daemon's `start` argv), plus a `claude` on PATH for the setup health.
  const mockCli = path.join(repoRoot, 'tests/providers/mock-claude.mjs')
  const binDir = path.join(tmpBase, 'bin')
  await fs.mkdir(binDir, { recursive: true })
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  await fs.writeFile(path.join(binDir, 'claude'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(mockCli)} "$@"\n`, { mode: 0o755 })
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`
  process.env.MOCK_CLAUDE_PLAIN_ECHO = '1'
  process.env.WALNUT_TASK_DIR_ROOT = path.join(tmpBase, 'task-dirs')
  delete process.env.WALNUT_TASK_DIR
  // A session's working folder (drawing-composer.spec.ts starts one in <home>/projects).
  await fs.mkdir(path.join(tmpBase, 'projects'), { recursive: true })
  // The Home chat slot starts closed, as on the shared fixture, so a session column has the room.
  await fs.mkdir(path.join(tmpBase, 'config', 'share'), { recursive: true })
  await fs.writeFile(path.join(tmpBase, 'config', 'share', 'ui-prefs.json'), JSON.stringify({ 'open-walnut-home-chat-visible': { v: 'false', ts: 1 } }, null, 2))
  const { sessionRunner } = await import('../../../src/providers/claude-code-session.js')
  sessionRunner.setCliCommand(mockCli)
  const { DaemonConnection } = await import('../../../src/providers/daemon-connection.js')
  const daemonSend = DaemonConnection.prototype.send
  DaemonConnection.prototype.send = function (command, payload, ...rest) {
    if (command === 'start') {
      const args = payload.args as string[]
      if (args?.[0] !== 'claude') throw new Error('Unexpected fixture executable')
      payload = { ...payload, args: [process.execPath, mockCli, ...args.slice(1)] }
    }
    return daemonSend.call(this, command, payload, ...rest)
  }
}

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
  // Its own dependency cache, as test-server.ts: a shared one is re-optimized under it.
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
