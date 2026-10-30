/**
 * Fixture server for plugin link handlers (`walnut.ui.link`, link-capture.spec.ts).
 *
 * Its own server, not the shared :3457 fixture, because the shared fixture installs no
 * plugins by design. This one LINKS the hand-written fixture plugin
 * (fixtures/link-capture-plugin, which opens `https://*.chat.example.com/archives/*`)
 * into a throwaway data home, seeds one task whose description and session carry chat
 * permalinks and other links, and starts the real server with Vite in front.
 *
 * Never :3456 and never the developer's data: OPEN_WALNUT_HOME, HOME and the daemon
 * dirs all point inside one temp directory that is removed on shutdown.
 *
 * Reads PW_LINK_CAPTURE_PORT; prints `LINK_CAPTURE_READY <json>` when it is serving.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fixtureHome } from './fixture-home'

const port = Number(process.env.PW_LINK_CAPTURE_PORT ?? 3461)
// Its own home for real: Bun reads HOME only at startup (fixture-home.ts).
const tmpBase = await fixtureHome(path.join(os.tmpdir(), `walnut-link-capture-${port}-${Date.now()}`))

process.env.OPEN_WALNUT_HOME = tmpBase
process.env.WALNUT_DAEMON_DIR = path.join(tmpBase, 'daemon')
process.env.WALNUT_STREAMS_DIR = path.join(tmpBase, 'daemon-streams')
process.env.WALNUT_DISABLE_SEARCH = '1'
process.env.WALNUT_DISABLE_BACKGROUND_AI = '1'
process.env.HOME = tmpBase
process.env.USERPROFILE = tmpBase
process.argv.push('--_ephemeral-child')

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

const LINKS = {
  /** The shape of a real chat permalink, on a made-up host the plugin handles. */
  permalink: 'https://acme.enterprise.chat.example.com/archives/C0123ABCDEF/p1700000000123456',
  /** A reply in a thread: the same path plus the thread's ts. */
  reply: 'https://acme.enterprise.chat.example.com/archives/C0123ABCDEF/p1700000013000200?thread_ts=1700000000.123456&cid=C0123ABCDEF',
  /** A workspace the plugin is not signed into (its `accepts` says no). */
  unknownWorkspace: 'https://unknown.chat.example.com/archives/C1/p1700000000123456',
  /** A channel the plugin cannot open (its `open` returns false). */
  declined: 'https://acme.enterprise.chat.example.com/archives/CDECLINE/p1700000000123456',
  /** A site no plugin handles. */
  plain: 'https://docs.example.org/guide/start',
}

const TASK = 't-link-capture'
const SID = 'sess-link-capture'
const now = new Date().toISOString()

const linkList = [
  `- Message: [the permalink](${LINKS.permalink})`,
  `- Reply: [the thread reply](${LINKS.reply})`,
  `- Other workspace: [unknown workspace](${LINKS.unknownWorkspace})`,
  `- Declined: [declined channel](${LINKS.declined})`,
  `- Elsewhere: [plain site](${LINKS.plain})`,
].join('\n')

await fs.rm(tmpBase, { recursive: true, force: true })
await fs.mkdir(path.join(tmpBase, 'tasks'), { recursive: true })
await fs.mkdir(path.join(tmpBase, 'plugins'), { recursive: true })

const mockMainAgent = path.join(repoRoot, 'tests/providers/mock-main-agent.mjs')
await fs.writeFile(path.join(tmpBase, 'config.yaml'), JSON.stringify({
  version: 1,
  defaults: { priority: 'none', platform: 'local' },
  provider: { type: 'claude-code' },
  agent: {
    main_provider: 'link-capture-cli',
    main_model: 'link-capture-mock',
    triage: { debounce_minutes: 0 },
  },
  providers: { 'link-capture-cli': { api: 'claude-cli', claude_cli_command: mockMainAgent } },
}, null, 2))

await fs.writeFile(path.join(tmpBase, 'tasks', 'tasks.json'), JSON.stringify({
  version: 1,
  tasks: [{
    id: TASK,
    title: 'Link capture fixture task',
    status: 'in_progress',
    phase: 'IN_PROGRESS',
    priority: 'none',
    project: 'Console',
    source: 'local',
    pinned: true,
    focus_tier: 'focus',
    pin_order: 0,
    session_ids: [SID],
    active_session_ids: [],
    created_at: now,
    updated_at: now,
    description: `Links to check:\n\n${linkList}`,
    summary: '',
    note: '',
    subtasks: [],
  }],
}, null, 2))

// A note with the same links, for the notes editor (it opens links itself, NotesEditor.tsx).
await fs.mkdir(path.join(tmpBase, 'notes'), { recursive: true })
await fs.writeFile(path.join(tmpBase, 'notes', 'Chat links.md'), `# Chat links\n\n${linkList}\n`)

const sessionCwd = path.join(tmpBase, 'project')
await fs.mkdir(sessionCwd, { recursive: true })
const jsonlDir = path.join(tmpBase, '.claude', 'projects', sessionCwd.replace(/[^a-zA-Z0-9]/g, '-'))
await fs.mkdir(jsonlDir, { recursive: true })
const startedAt = Date.now() - 60 * 60_000
await fs.writeFile(path.join(tmpBase, 'sessions.json'), JSON.stringify({
  version: 2,
  sessions: [{
    claudeSessionId: SID,
    taskId: TASK,
    project: 'Console',
    process_status: 'stopped',
    mode: 'bypass',
    last_status_change: new Date(startedAt).toISOString(),
    startedAt: new Date(startedAt).toISOString(),
    lastActiveAt: new Date(startedAt + 10 * 60_000).toISOString(),
    messageCount: 2,
    cwd: sessionCwd,
    title: 'Read the chat thread',
  }],
}, null, 2))
await fs.writeFile(path.join(jsonlDir, `${SID}.jsonl`), [
  JSON.stringify({
    type: 'user',
    sessionId: SID,
    timestamp: new Date(startedAt).toISOString(),
    message: { role: 'user', content: `Please read this thread: ${LINKS.permalink}` },
  }),
  JSON.stringify({
    type: 'assistant',
    sessionId: SID,
    timestamp: new Date(startedAt + 30_000).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: `link capture answer. The links I found:\n\n${linkList}\n\nBare: ${LINKS.reply}` }] },
  }),
  '',
].join('\n'))

// Install the plugin the documented author way: a symlink in the data home's
// plugins/ directory, which is exactly what `walnut-plugin link` writes.
await fs.symlink(
  path.join(repoRoot, 'tests/e2e/browser/fixtures/link-capture-plugin'),
  path.join(tmpBase, 'plugins', 'link-capture-fixture'),
  'dir',
)

const { startServer, stopServer } = await import('../../../src/web/server.js')
const apiServer = await startServer({ port: 0, dev: true })
const apiAddress = apiServer.address()
if (!apiAddress || typeof apiAddress === 'string') throw new Error('Link capture fixture did not bind a TCP port')
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

const fixture = { port, home: tmpBase, taskId: TASK, sessionId: SID, links: LINKS }
console.log(`LINK_CAPTURE_READY ${JSON.stringify(fixture)}`)

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
