/**
 * Fixture server for a plugin's ACCOUNT LINK in Settings → Plugins and the
 * "sign in again" notification the sync loop raises for it.
 *
 * One fixture plugin, `linkfix`, written into a throwaway home's plugins/ dir. It
 * registers a sync adapter and a PluginConnection with a scripted credential:
 *   - it starts SIGNED OUT: status() is 'sign-in-required' and every syncPoll
 *     throws a typed sign-in-required error (authKind on the Error), which is
 *     exactly what Microsoft To-Do throws when its refresh token is dead;
 *   - signIn() hands back a device code at once and, SIGN_IN_COMPLETES_MS later,
 *     flips the credential to connected (as if the human finished in the browser);
 *   - from then on syncPoll succeeds and status() is 'connected'.
 * The real Microsoft plugin needs a real Azure app and a real human at
 * microsoft.com/devicelogin, so it cannot be driven from a spec; the scripted
 * link exercises the same Walnut halves (loop → card → Settings → sign-in →
 * poll → recovery) against the same contract.
 *
 * Sync ticks are made fast (WALNUT_SYNC_FIRST_TICK_MS, sync_interval_ms) so the
 * spec watches the first failing tick and the first good one within seconds.
 *
 * Never :3456 and never the developer's data: OPEN_WALNUT_HOME, HOME and the
 * daemon dirs all point inside one temp directory that is removed on shutdown.
 *
 * Run: ./node_modules/.bin/tsx tests/e2e/browser/plugin-connection-server.ts
 * Reads PW_PLUGIN_CONNECTION_PORT; prints `PLUGIN_CONNECTION_READY <json>` when serving.
 */

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const port = Number(process.env.PW_PLUGIN_CONNECTION_PORT ?? 3463)
const tmpBase = path.join(os.tmpdir(), `walnut-plugin-connection-${port}-${Date.now()}`)

process.env.OPEN_WALNUT_HOME = tmpBase
process.env.WALNUT_DAEMON_DIR = path.join(tmpBase, 'daemon')
process.env.WALNUT_STREAMS_DIR = path.join(tmpBase, 'daemon-streams')
process.env.WALNUT_DISABLE_SEARCH = '1'
process.env.WALNUT_DISABLE_BACKGROUND_AI = '1'
process.env.WALNUT_SYNC_FIRST_TICK_MS = '1500'
process.env.HOME = tmpBase
process.env.USERPROFILE = tmpBase
process.argv.push('--_ephemeral-child')

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

const PLUGIN_ID = 'linkfix'
const PLUGIN_NAME = 'Linkfix'
const SIGN_IN_COMPLETES_MS = 4000
const SYNC_INTERVAL_MS = 1500

// Reclaim siblings left by fixture servers that were SIGKILLed before their shutdown
// handler ran, then claim this dir so the next run can tell it from debris.
const { sweepStaleTmpDirs, writeOwnerPid } = await import('../../setup/stale-tmp.js')
sweepStaleTmpDirs([{ prefix: 'walnut-plugin-connection-', name: /^walnut-plugin-connection-\d+-\d+$/, pidFrom: 'owner-file' }])
await fs.rm(tmpBase, { recursive: true, force: true })
await fs.mkdir(path.join(tmpBase, 'tasks'), { recursive: true })
writeOwnerPid(tmpBase)
await fs.mkdir(path.join(tmpBase, 'plugins', PLUGIN_ID, 'dist'), { recursive: true })

const mockMainAgent = path.join(repoRoot, 'tests/providers/mock-main-agent.mjs')
await fs.writeFile(path.join(tmpBase, 'config.yaml'), JSON.stringify({
  version: 1,
  defaults: { priority: 'none', platform: 'local' },
  provider: { type: 'claude-code' },
  agent: {
    main_provider: 'link-cli',
    main_model: 'link-mock',
    triage: { debounce_minutes: 0 },
  },
  providers: { 'link-cli': { api: 'claude-cli', claude_cli_command: mockMainAgent } },
  plugins: { [PLUGIN_ID]: { enabled: true, sync_interval_ms: SYNC_INTERVAL_MS } },
}, null, 2))
await fs.writeFile(path.join(tmpBase, 'tasks', 'tasks.json'), JSON.stringify({ version: 1, tasks: [] }, null, 2))

await fs.writeFile(path.join(tmpBase, 'plugins', PLUGIN_ID, 'manifest.json'), JSON.stringify({
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: 'A fixture account link: signed out until you sign in.',
  version: '1.0.0',
  apiVersion: 1,
  engines: { walnut: '>=0.0.0' },
  server: 'dist/server.mjs',
}, null, 2))

await fs.writeFile(path.join(tmpBase, 'plugins', PLUGIN_ID, 'dist', 'server.mjs'), `
// The scripted credential. Module state, like a real plugin's token cache.
const link = { state: 'sign-in-required', account: undefined, prompt: null, timer: null };
const SIGN_IN_COMPLETES_MS = ${SIGN_IN_COMPLETES_MS};

class LinkAuthError extends Error {
  constructor(kind, message, code) {
    super(message);
    this.authKind = kind;
    if (code) this.authCode = code;
  }
}

function status() {
  if (link.state === 'signing-in') {
    return { state: 'signing-in', signIn: link.prompt, detail: 'Finish the sign-in in your browser; this updates on its own when you are done.' };
  }
  if (link.state === 'connected') {
    return {
      state: 'connected',
      account: link.account,
      credentialExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      detail: 'Connected. The credential renews on its own; you only sign in again if the provider revokes it.',
    };
  }
  return { state: 'sign-in-required', detail: 'The provider refused to renew the credential (invalid_grant). Sync is paused until you sign in.' };
}

const noop = async () => {};
const sync = {
  createTask: async () => null,
  deleteTask: noop, updateTitle: noop, updateDescription: noop, updateSummary: noop, updateNote: noop,
  updateConversationLog: noop, updatePriority: noop, updatePhase: noop, updateDueDate: noop,
  updateProject: noop, updateDependencies: noop,
  pushTask: async () => ({ serverTimestamp: new Date().toISOString() }),
  associateSubtask: noop, disassociateSubtask: noop,
  async syncPoll() {
    if (link.state !== 'connected') {
      throw new LinkAuthError('sign-in-required', '${PLUGIN_NAME} needs you to sign in again (invalid_grant).', 'invalid_grant');
    }
  },
  fullPull: async () => [],
  extractRemoteId: () => undefined,
};

export function activate(walnut) {
  walnut.registry.sync(sync);
  // Every sync plugin owns an ext index; the push path refuses to run without one.
  walnut.registry.extIndex({ source: '${PLUGIN_ID}', paths: [{ key: 'id', json: '$."${PLUGIN_ID}".id', unique: true }] });
  walnut.registry.connection({
    async status() { return status(); },
    async signIn() {
      if (link.state === 'signing-in' && link.prompt) return link.prompt;
      const startedAt = new Date();
      link.prompt = {
        userCode: 'FIX-2468',
        verificationUri: 'https://example.invalid/devicelogin',
        message: 'Enter the code FIX-2468 at https://example.invalid/devicelogin',
        startedAt: startedAt.toISOString(),
        expiresAt: new Date(startedAt.getTime() + 15 * 60_000).toISOString(),
      };
      link.state = 'signing-in';
      clearTimeout(link.timer);
      link.timer = setTimeout(() => {
        link.state = 'connected';
        link.account = 'fixture@example.com';
        link.prompt = null;
      }, SIGN_IN_COMPLETES_MS);
      return link.prompt;
    },
  });
}
export function deactivate() { clearTimeout(link.timer); }
`)

const { startServer, stopServer } = await import('../../../src/web/server.js')
const apiServer = await startServer({ port: 0, dev: true })
const apiAddress = apiServer.address()
if (!apiAddress || typeof apiAddress === 'string') throw new Error('Plugin connection fixture did not bind a TCP port')
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

const fixture = { port, home: tmpBase, pluginId: PLUGIN_ID, pluginName: PLUGIN_NAME, signInCompletesMs: SIGN_IN_COMPLETES_MS, syncIntervalMs: SYNC_INTERVAL_MS }
await fs.writeFile(path.join(tmpBase, 'fixture.json'), JSON.stringify(fixture, null, 2))
console.log(`PLUGIN_CONNECTION_READY ${JSON.stringify(fixture)}`)

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
  // SIGKILLs us well before that; the rm must run while this process still can.
  await Promise.race([teardown.catch(() => {}), new Promise((r) => setTimeout(r, 8_000))])
  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
// Two other SIGTERM handlers in this process used to end it before `shutdown` got
// past its first await, so the tmpdir (and its daemon) survived every run — the
// same defect test-server.ts had (2026-09-13 disk-full incident):
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
