/**
 * Fixture server for the gated Mail console.
 *
 * Its OWN server, not the shared :3457 fixture, for one reason: this spec turns the mail
 * plugin OFF, and the switch persists (`plugins.mail.enabled: false` lands in config.yaml).
 * A failure between the off and the on would leave that behind, and the next local run of
 * ANY spec would attach to the same fixture (`reuseExistingServer`) with mail disabled and
 * no idea why. A throwaway home cannot outlive the run.
 *
 * The mail BASE is provisioned by nobody: it is a builtin, so a stock install already has it
 * active, which is exactly the state the gate spec tests.
 *
 * `PW_MAIL_INBOUND_PROVIDER=1` makes that provider plugin register a SECOND provider that declares
 * `send: false`, which is what the write spec needs to see a compose button refuse itself. It is a
 * flag because the read spec counts the provider options in the add-an-account dialog.
 *
 * `PW_MAIL_PROVIDER=1` additionally links a canned PROVIDER plugin
 * (`fixtures/mail-fixture-provider/`) the documented author way, so the read-path spec has
 * accounts, mailboxes, envelopes and a hostile HTML body to open. It is a FLAG rather than the
 * default because the gate spec's subject is a stock install, which already has one dependent
 * (the IMAP provider): the flag only changes how many plugins the cascade ask names, so keeping
 * it off keeps that spec's screenshots and copy about what a real fresh install looks like.
 *
 * `PW_MAIL_DENSE=1` links `fixtures/mail-dense-provider/` instead: TWO accounts at production density
 * (64 folders against 6, the same roles under different mailbox ids, stale unread in the collapsed
 * tail), adopted with no dialog. See the note next to the symlink below for why it is a separate
 * fixture and not a mode of the one above.
 *
 * Never :3456 and never the developer's data: OPEN_WALNUT_HOME, HOME and the daemon dirs all
 * point inside one temp directory that is removed on shutdown.
 *
 * Run: ./node_modules/.bin/tsx tests/e2e/browser/mail-app-server.ts
 * Reads PW_MAIL_PORT; prints `MAIL_FIXTURE_READY <json>` when it is serving.
 */

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
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

// Reclaim siblings left by fixture servers that were SIGKILLed before their shutdown
// handler ran, then claim this dir so the next run can tell it from debris.
const { sweepStaleTmpDirs, writeOwnerPid } = await import('../../setup/stale-tmp.js')
sweepStaleTmpDirs([{ prefix: 'walnut-mail-app-', name: /^walnut-mail-app-\d+-\d+$/, pidFrom: 'owner-file' }])
await fs.rm(tmpBase, { recursive: true, force: true })
await fs.mkdir(path.join(tmpBase, 'tasks'), { recursive: true })
writeOwnerPid(tmpBase)
await fs.mkdir(path.join(tmpBase, 'plugins'), { recursive: true })

/**
 * `PW_MAIL_DIGEST_OFF=1` parks the SCHEDULED digest.
 *
 * A spec that drives "Send digest now" has to see exactly the letter it asked for, and the poll
 * tick fires every two minutes: after 08:00 local, a run would otherwise race an unasked-for
 * digest into the inbox. `sendNow` deliberately does not consult this switch (the menu item is the
 * human asking, not the schedule running), which is what lets the two be tested apart.
 */
const digestOff = process.env.PW_MAIL_DIGEST_OFF === '1'

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
  ...(digestOff ? { plugins: { mail: { digest_enabled: false } } } : {}),
}, null, 2))

await fs.writeFile(path.join(tmpBase, 'tasks', 'tasks.json'), JSON.stringify({ version: 1, tasks: [] }, null, 2))

// Install the canned provider the documented author way: a symlink in the data home's plugins/
// directory, which is exactly what `walnut-plugin link` writes. It declares
// `dependencies: { mail }`, so the loader activates it after the base.
const withProvider = process.env.PW_MAIL_PROVIDER === '1'
if (withProvider) {
  const providerSource = path.join(repoRoot, 'tests/e2e/browser/fixtures/mail-fixture-provider')
  await fs.access(path.join(providerSource, 'server.mjs'))
  await fs.symlink(providerSource, path.join(tmpBase, 'plugins', 'mail-fixture-provider'), 'dir')
}

/**
 * `PW_MAIL_DENSE=1` links the DENSE provider instead: two accounts, 70 folders, 160 messages.
 *
 * Its own flag and its own directory rather than a mode of the other fixture, because the two answer
 * opposite questions. `mail-fixture-provider` is a small mailbox whose every row a spec can name, and
 * several specs count its folders; this one is production density (64 folders against 6, the same roles
 * under different ids, a 90-character folder id, stale unread in the tail) and exists so the sidebar's
 * collapse and its smart rows are graded against the numbers they were designed for.
 *
 * It declares no setup fields, so both accounts are adopted at registration with no dialog. The two are
 * not mutually exclusive here, but a spec should pick ONE: with both linked the add-an-account dialog
 * offers two providers and every folder count doubles.
 */
const withDense = process.env.PW_MAIL_DENSE === '1'
if (withDense) {
  const denseSource = path.join(repoRoot, 'tests/e2e/browser/fixtures/mail-dense-provider')
  await fs.access(path.join(denseSource, 'server.mjs'))
  await fs.symlink(denseSource, path.join(tmpBase, 'plugins', 'mail-dense-provider'), 'dir')
}

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

// `outbox` is where the canned provider writes every message it was handed, so the write spec can
// assert what went over the wire rather than what the console said about it.
const fixture = {
  port,
  home: tmpBase,
  provider: withProvider,
  dense: withDense,
  digestOff,
  outbox: path.join(tmpBase, 'mail-fixture-sends.json'),
  denseOutbox: path.join(tmpBase, 'mail-dense-sends.json'),
}
await fs.writeFile(path.join(tmpBase, 'fixture.json'), JSON.stringify(fixture, null, 2))
console.log(`MAIL_FIXTURE_READY ${JSON.stringify(fixture)}`)

let shuttingDown = false
const shutdown = async () => {
  // SIGTERM arrives both directly and relayed by tsx; one teardown, not two.
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
  // Bounded: stopIfIsolated() polls the daemon pid for up to 30s while the spec
  // SIGKILLs us at 15s; the rm must run while this process still can.
  await Promise.race([teardown.catch(() => {}), new Promise((r) => setTimeout(r, 8_000))])
  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
// Two other SIGTERM handlers in this process end it before `shutdown` gets past
// its first await, leaving the isolated daemon and tmpBase behind — observed
// 2026-09-18: two of these fixtures orphaned for 4-6h with their daemons, 25
// `walnut-mail-app-*` homes in $TMPDIR. Same defect test-server.ts had:
//  1. startServer() re-raises SIGTERM with the default disposition unless told an
//     owner will exit after teardown.
//  2. Vite's dev server registers `parentSigtermCallback` (also on stdin 'end'),
//     which closes itself and process.exit()s. No opt-out API; unhooked by name.
const { armGracefulSignalExit } = await import('../../../src/web/server.js')
armGracefulSignalExit()
for (const l of process.listeners('SIGTERM')) if (l.name === 'parentSigtermCallback') process.off('SIGTERM', l)
for (const l of process.stdin.listeners('end')) if (l.name === 'parentSigtermCallback') process.stdin.off('end', l)
// Last word on the tmpdir: startServer()'s own 'exit' handler appends a final log
// line inside tmpBase after `shutdown` removed it. Registered after it, runs after it.
process.on('exit', () => {
  try { fsSync.rmSync(tmpBase, { recursive: true, force: true, maxRetries: 3 }) } catch { /* best effort */ }
})
