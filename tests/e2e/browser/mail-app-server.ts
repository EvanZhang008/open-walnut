/**
 * Fixture server for the gated Mail console.
 *
 * Its OWN server, not the shared :3457 fixture, for one reason: this spec turns the mail
 * plugin OFF, and the switch persists (`plugins.mail.enabled: false` lands in config.yaml).
 * A failure between the off and the on would leave that behind, and the next local run of
 * ANY spec would attach to the same fixture (`reuseExistingServer`) with mail disabled and
 * no idea why. A throwaway home cannot outlive the run.
 *
 * It provisions nothing: mail is a builtin, so a stock install already has it active, which
 * is exactly the state under test.
 *
 * Never :3456 and never the developer's data: OPEN_WALNUT_HOME, HOME and the daemon dirs all
 * point inside one temp directory that is removed on shutdown.
 *
 * Run: ./node_modules/.bin/tsx tests/e2e/browser/mail-app-server.ts
 * Reads PW_MAIL_PORT; prints `MAIL_FIXTURE_READY <json>` when it is serving.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const port = Number(process.env.PW_MAIL_PORT ?? 3463)
const tmpBase = path.join(os.tmpdir(), `walnut-mail-app-${port}-${Date.now()}`)

// Set the data home BEFORE importing any server module: constants.ts resolves it at import
// time. `--_ephemeral-child` on argv is what stops the leaked-tmpdir guard from pulling it
// back to ~/.open-walnut.
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

// No live model calls from a fixture: the main agent points at the repo's mock CLI.
const mockMainAgent = path.join(repoRoot, 'tests/providers/mock-main-agent.mjs')
await fs.writeFile(path.join(tmpBase, 'config.yaml'), JSON.stringify({
  version: 1,
  defaults: { priority: 'none', platform: 'local' },
  provider: { type: 'claude-code' },
  agent: {
    main_provider: 'mail-cli',
    main_model: 'mail-mock',
    triage: { debounce_minutes: 0 },
  },
  providers: { 'mail-cli': { api: 'claude-cli', claude_cli_command: mockMainAgent } },
}, null, 2))

await fs.writeFile(path.join(tmpBase, 'tasks', 'tasks.json'), JSON.stringify({ version: 1, tasks: [] }, null, 2))

const { startServer, stopServer } = await import('../../../src/web/server.js')
const apiServer = await startServer({ port: 0, dev: true })
const apiAddress = apiServer.address()
if (!apiAddress || typeof apiAddress === 'string') throw new Error('Mail fixture did not bind a TCP port')
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

const fixture = { port, home: tmpBase }
await fs.writeFile(path.join(tmpBase, 'fixture.json'), JSON.stringify(fixture, null, 2))
console.log(`MAIL_FIXTURE_READY ${JSON.stringify(fixture)}`)

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
