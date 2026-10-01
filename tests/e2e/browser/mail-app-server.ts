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

/**
 * `PW_MAIL_POLL_SECONDS=<n>`: the plugin's poll interval, for a spec about what the loop does on its own
 * (the unread check on every tick). Unset, the plugin's default applies and no spec waits on a tick.
 */
const pollSeconds = Number(process.env.PW_MAIL_POLL_SECONDS ?? '')
const mailPluginConfig = {
  ...(digestOff ? { digest_enabled: false } : {}),
  ...(Number.isFinite(pollSeconds) && pollSeconds > 0 ? { poll_interval_seconds: pollSeconds } : {}),
}

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
  ...(Object.keys(mailPluginConfig).length > 0 ? { plugins: { mail: mailPluginConfig } } : {}),
}, null, 2))

await fs.writeFile(path.join(tmpBase, 'tasks', 'tasks.json'), JSON.stringify({ version: 1, tasks: [] }, null, 2))

// Install the canned provider the documented author way: a symlink in the data home's plugins/
// directory, which is exactly what `walnut-plugin link` writes. It declares
// `dependencies: { mail }`, so the loader activates it after the base.
/**
 * `PW_MAIL_CTX=1`: the row-menu shape. Implies the canned provider, since that is where the two
 * accounts live (one that can mark read and send, one that can do neither).
 *
 * It also arms two seams below, both of them in THIS file rather than in the plugin:
 *  - canned answers for four of the five folder-fetch outcomes, because `stopped` and
 *    `unknown-mailbox` are the plugin's own bookkeeping and `running` is a ten second deadline;
 *  - one real task, made through the real route, so a row that already has one is on screen.
 */
const withCtx = process.env.PW_MAIL_CTX === '1'

/**
 * `PW_MAIL_WRITES_503=1`: every WRITE to the mail plugin answers 503 `primary_only`, reads do not.
 *
 * Replica mode is the real thing this imitates, and it is useless here: the base steps aside
 * completely, so there are no accounts, no folders and no rows to right-click. A menu whose items
 * refuse themselves needs the rows present and the writes refused, which is this.
 */
const writes503 = process.env.PW_MAIL_WRITES_503 === '1'

/**
 * `PW_MAIL_UNSUB=1` is a message SET inside the canned provider, so it implies the provider link the
 * same way `PW_MAIL_CTX=1` does. Without this the flag reached the provider and the provider was never
 * installed, so the install had no accounts at all and every case timed out waiting for the accounts
 * pane — a fixture that answers "no mail accounts yet" reads exactly like a product bug.
 */
const withUnsub = process.env.PW_MAIL_UNSUB === '1'

/** `PW_MAIL_INVITE=1`: meeting invites on the writer account (invite-set.mjs). Implies the link too. */
const withInvite = process.env.PW_MAIL_INVITE === '1'

/**
 * `PW_MAIL_GROUPS=1`: the inbox-sorting message set (two adopted accounts, marina and ferry, see
 * `fixtures/mail-fixture-provider/groups-set.mjs`). `PW_MAIL_GROUPS_DENSE=1` is the same two accounts
 * at 1,500 rows each. Both imply the canned provider link and serve `/__fixture/*` on this port.
 *
 * `PW_MAIL_RULE_MODEL=canned|invalid|down|slow` (default `down`) replaces the host's `model.fastText`
 * seam, so a test server NEVER reaches a real model: `canned` answers a rule matching the corrected
 * mail's sender with `addressedToMe: false`, `invalid` answers text that is not JSON, `down` throws,
 * `slow` answers after 15 s. Every call is counted (`GET /__fixture/model-calls`).
 */
const withGroupsDense = process.env.PW_MAIL_GROUPS_DENSE === '1'
const withGroups = process.env.PW_MAIL_GROUPS === '1' || withGroupsDense
const ruleModelMode = (['canned', 'invalid', 'down', 'slow'] as const)
  .find((mode) => mode === process.env.PW_MAIL_RULE_MODEL) ?? 'down'

const withProvider = process.env.PW_MAIL_PROVIDER === '1' || withCtx || withUnsub || withInvite || withGroups
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

// Sessions run the repo's mock CLI, never a real `claude`: the Ask drawer starts an ordinary Ask Walnut
// session. Same two seams as test-server.ts (the runner's command, and the daemon's `start` argv).
// The mock writes no CLI transcript, so a spec sees the mock's echo of what a launch sent, not the user
// turn itself: assert on the echo (and on the quick-start body), never on a user bubble.
const mockCli = path.join(repoRoot, 'tests/providers/mock-claude.mjs')
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

const groupsSet = await import('./fixtures/mail-fixture-provider/groups-set.mjs')
const { handleGroupsFixture } = await import('./fixtures/mail-fixture-provider/groups-endpoints.mjs')

// The rule model AND the labeling model, faked for EVERY run (not only grouping ones): a fixture never
// calls a real model. Labeling calls are told apart by their system prompt (groups-labeler.mjs).
const { setPluginFastTextOverride } = await import('../../../src/core/plugins/plugin-fast-text.js')
const { fixtureLabelAnswer, fixtureSummaryAnswer, isLabelRequest, isSummaryRequest } = await import('./fixtures/mail-fixture-provider/groups-labeler.mjs')
setPluginFastTextOverride(async (request) => {
  const user = request.messages.find((one) => one.role === 'user')?.content ?? ''
  if (isLabelRequest(request) || isSummaryRequest(request)) {
    const state = groupsSet.groupsState() as { labelCalls?: unknown[]; summaryCalls?: unknown[]; labelMode?: string }
    const mode = state.labelMode ?? process.env.PW_MAIL_LABEL_MODEL ?? 'ok'
    const summary = isSummaryRequest(request)
    const calls = summary ? (state.summaryCalls ??= []) : (state.labelCalls ??= [])
    calls.push({ mode, at: Date.now(), user })
    if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 8_000))
    return summary ? fixtureSummaryAnswer(user, mode) : fixtureLabelAnswer(user, mode)
  }
  groupsSet.groupsState().modelCalls.push({ mode: ruleModelMode, at: Date.now(), user })
  if (ruleModelMode === 'down') throw new Error('The fixture model is down.')
  if (ruleModelMode === 'invalid') return 'Sure! Here is a rule: from the sender, probably.'
  if (ruleModelMode === 'slow') {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 15_000)
      request.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
    })
  }
  let parsed: { target?: string; mail?: { fromAddr?: string; fromName?: string } } = {}
  try { parsed = JSON.parse(user) } catch { /* canned answers even a message it cannot read */ }
  const from = parsed.mail?.fromAddr || parsed.mail?.fromName || 'unknown'
  return JSON.stringify({ when: { from, addressedToMe: false }, then: parsed.target ?? 'Important' })
})

// Unsubscribe targets, for grouping runs: every request is logged and answered here. The guard still
// judges each url (the resolver answers a documentation address, never loopback); the setter only
// installs inside a test runner, so the runner's own signal is raised for that one call.
if (withGroups) {
  const { setUnsubscribeHttpForTesting } = await import('../../../src/integrations/mail/unsubscribe-http.js')
  const previousEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'test'
  try {
    setUnsubscribeHttpForTesting({
      lookup: async () => [{ address: '203.0.113.10', family: 4 }],
      fetch: async (url, init) => {
        const delay = groupsSet.groupsState().unsubDelayMs ?? 0
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
        groupsSet.groupsState().unsubLog.push({ kind: 'https', method: String(init.method ?? 'GET'), url, at: Date.now() })
        return new Response('<html><body><p>You have been unsubscribed.</p></body></html>', {
          status: 200, headers: { 'content-type': 'text/html' },
        })
      },
    })
  } finally {
    if (previousEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousEnv
  }
}

const { startServer, stopServer } = await import('../../../src/web/server.js')
const apiServer = await startServer({ port: 0, dev: true })
const apiAddress = apiServer.address()
if (!apiAddress || typeof apiAddress === 'string') throw new Error('Mail fixture did not bind a TCP port')
const apiTarget = `http://127.0.0.1:${apiAddress.port}`

/**
 * The two seams, as ONE middleware in front of the proxy.
 *
 * Installed by calling `server.middlewares.use` inside `configureServer` (which mounts it BEFORE
 * Vite's own middlewares, the proxy among them), so a request it answers never reaches the API at
 * all. It only ever answers requests the flags asked for; everything else falls through untouched,
 * which is what keeps the reads in a 503 run real.
 */
const CANNED_FETCH: Record<string, { status: number; body: Record<string, unknown> }> = {
  'ctx-fetch-running': { status: 202, body: { ok: true, fetched: false, running: true } },
  'ctx-fetch-unknown': { status: 200, body: { ok: true, fetched: false, reason: 'unknown-mailbox' } },
  'ctx-fetch-stopped': { status: 200, body: { ok: true, fetched: false, reason: 'stopped' } },
  'ctx-fetch-failed': {
    status: 200,
    body: { ok: true, fetched: false, reason: 'failed', detail: 'The folder refused to open.' },
  },
}

function mailFixtureSeams() {
  return {
    name: 'walnut-mail-fixture-seams',
    configureServer(server: { middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void } }) {
      // The grouping fixture's own endpoints, on this port (spec helpers call them here).
      if (withGroups) {
        server.middlewares.use((req, res, next) => {
          if (!String(req.url ?? '').startsWith('/__fixture/')) return next()
          if (!handleGroupsFixture(req, res)) next()
        })
      }
      if (!writes503 && !withCtx) return
      server.middlewares.use((req, res, next) => {
        const url: string = req.url ?? ''
        const method: string = (req.method ?? 'GET').toUpperCase()
        if (!url.startsWith('/api/plugins/mail')) return next()
        const answer = (status: number, body: unknown) => {
          res.statusCode = status
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(body))
        }
        if (writes503 && method !== 'GET' && method !== 'HEAD') {
          return answer(503, { error: 'primary_only', message: 'Mail runs on your primary Walnut box.' })
        }
        if (!withCtx || method !== 'POST' || !url.startsWith('/api/plugins/mail/mailboxes/fetch')) return next()
        // The body names the folder, so it has to be read here. A request that turns out NOT to be
        // one of the canned folders cannot be handed back to the proxy (its body is consumed), so it
        // is forwarded from here instead: `ctx-fetch-ok` really does go through the plugin.
        let raw = ''
        req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8') })
        req.on('end', () => {
          let mailboxId = ''
          try { mailboxId = String((JSON.parse(raw || '{}') as { mailboxId?: string }).mailboxId ?? '') }
          catch { mailboxId = '' }
          const canned = CANNED_FETCH[mailboxId]
          if (canned) { answer(canned.status, canned.body); return }
          void fetch(`${apiTarget}${url}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: raw,
          })
            .then(async (upstream) => { answer(upstream.status, await upstream.json()) })
            .catch((error: unknown) => answer(502, { error: 'fixture', message: String(error) }))
        })
      })
    },
  }
}

const { createServer: createViteServer } = await import('vite')
// The page's own Origin restated as the API's, as test-server.ts does: without it the server refuses
// every browser write and the WebSocket upgrade as cross-site (403 "came from another site").
const { restateOwnOrigin } = await import('../../../web/dev-proxy-origin.js')
const viteServer = await createViteServer({
  root: path.join(repoRoot, 'web'),
  plugins: [mailFixtureSeams()],
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

/**
 * One row that already carries a task, made through the REAL route before the browser opens.
 *
 * `taskId` on a message is the plugin's own bookkeeping, so a fixture provider cannot seed it: the
 * honest way is to ask the route that writes it. Straight at the API rather than through the proxy,
 * so a `PW_MAIL_WRITES_503` run still gets its seeded row (the seam lives on the Vite server).
 *
 * Bounded and non-fatal: the first sweep has to land first, and a fixture that could not seed it
 * reports `taskId: null` rather than hanging the run.
 */
async function seedRowWithTask(): Promise<{ accountId: string; messageId: string; taskId: string } | null> {
  const accountId = 'fixture:ctx-writer@example.invalid'
  const deadline = Date.now() + 30_000
  const query = `account=${encodeURIComponent(accountId)}&mailbox=INBOX&limit=10`
  while (Date.now() < deadline) {
    const page = await fetch(`${apiTarget}/api/plugins/mail/messages?${query}`)
      .then((one) => (one.ok ? one.json() as Promise<{ messages?: { messageId: string }[] }> : null))
      .catch(() => null)
    const rows = page?.messages ?? []
    // The one canned message that starts READ, so the seeded task does not also change a read flag.
    const target = rows.find((one) => one.messageId === 'INBOX:1:29')
    if (target) {
      const made = await fetch(
        `${apiTarget}/api/plugins/mail/messages/${encodeURIComponent(accountId)}/${encodeURIComponent(target.messageId)}/task`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      )
        .then((one) => one.json() as Promise<{ taskId?: string }>)
        .catch(() => ({} as { taskId?: string }))
      if (made.taskId) return { accountId, messageId: target.messageId, taskId: made.taskId }
      return null
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

const ctxTaskRow = withCtx ? await seedRowWithTask() : null

// `outbox` is where the canned provider writes every message it was handed, so the write spec can
// assert what went over the wire rather than what the console said about it.
const fixture = {
  port,
  home: tmpBase,
  provider: withProvider,
  dense: withDense,
  digestOff,
  ctx: withCtx,
  writes503,
  /** The two accounts `PW_MAIL_CTX` adopts, and the row that already has a task. */
  ctxWriter: withCtx ? 'fixture:ctx-writer@example.invalid' : null,
  ctxReader: withCtx ? 'inbound:ctx-reader@example.invalid' : null,
  ctxFetchFolders: withCtx
    ? ['ctx-fetch-ok', 'ctx-fetch-running', 'ctx-fetch-unknown', 'ctx-fetch-stopped', 'ctx-fetch-failed']
    : [],
  ctxTaskRow,
  groups: withGroups,
  groupsDense: withGroupsDense,
  ruleModel: ruleModelMode,
  groupsAccounts: withGroups ? { marina: groupsSet.MARINA, ferry: groupsSet.FERRY } : null,
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
