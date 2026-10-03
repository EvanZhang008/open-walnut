/**
 * Fixture server for the Changed tab's commit view (session-commit.spec.ts).
 *
 * Its own server, not the shared :3457 fixture, because that one runs sessions on
 * a MockDaemon, which has no changes pipeline and no git: here the sessions run
 * through a REAL local daemon compiled from this checkout's daemon-standalone.ts
 * (into this fixture's temp dir, never dist/), driving the mock CLI's
 * `file-edit-turn:` mode, which edits files on disk and writes the transcript the
 * daemon reads.
 *
 * What it provisions in ONE throwaway directory (removed on shutdown):
 *   - HOME, OPEN_WALNUT_HOME and the daemon dirs;
 *   - a git repo `project/` (one commit, pushed) whose origin is a bare repo under
 *     `remotes/github.com/acme/widget.git`: a local path, so a push really lands,
 *     that still reads as a GitHub remote, so the PR action is decided by gh alone;
 *   - a PATH without gh (and without the developer's real `claude`): the daemon's
 *     login-shell PATH comes from a `sh` wrapper that pins it;
 *   - a global git config with an identity, no system config.
 *
 * Never :3456 and never the developer's data. Prints SESSION_COMMIT_READY <json>
 * and writes the same JSON to $SESSION_COMMIT_MANIFEST.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const port = Number(process.env.PW_TEST_PORT ?? 3514)
if (port === 3456) throw new Error('Production port is forbidden')
const manifest = process.env.SESSION_COMMIT_MANIFEST
if (!manifest) throw new Error('SESSION_COMMIT_MANIFEST is required')
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
// Read before HOME moves into the fixture: bun lives under the developer's home.
const realHome = os.homedir()
// A manifest left by a run that died must never point this run's spec at old data.
fs.rmSync(manifest, { force: true })
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-session-commit-ui-')))
// The temp dir goes on 'exit', synchronously, so any path out of the process
// (the shutdown below, a boot failure) removes it.
process.on('exit', () => {
  try {
    const pid = Number(fs.readFileSync(path.join(root, 'daemon/daemon.pid'), 'utf8').trim())
    if (Number.isInteger(pid) && pid > 1) process.kill(pid, 'SIGTERM')
  } catch { /* no daemon, or already gone */ }
  if (root.includes('walnut-session-commit-ui-')) fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(manifest, { force: true })
})
const inRoot = (p: string) => { if (!path.resolve(p).startsWith(root + path.sep)) throw new Error('outside the fixture root: ' + p) }

// A PATH this fixture controls: the mock CLI, node, system git. No gh anywhere.
const toolbox = path.join(root, '.toolbox/bin')
const nodeBin = path.join(root, 'node-bin')
const shellBin = path.join(root, 'shell-bin')
for (const d of [toolbox, nodeBin, shellBin]) fs.mkdirSync(d, { recursive: true })
fs.symlinkSync(process.execPath, path.join(nodeBin, 'node'))
const PATH = [toolbox, nodeBin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':')
// The daemon asks `$SHELL -lc` for the user's PATH; a login /bin/sh would add
// /etc/paths.d (Homebrew, where gh lives). This wrapper answers with PATH above.
fs.writeFileSync(path.join(shellBin, 'sh'), [
  '#!/bin/sh',
  `PATH=${JSON.stringify(PATH)}; export PATH`,
  'if [ "$1" = "-lc" ]; then shift; exec /bin/sh -c "$@"; fi',
  'exec /bin/sh "$@"',
  '',
].join('\n'), { mode: 0o755 })
const mock = path.join(repoRoot, 'tests/providers/mock-claude.mjs')
fs.writeFileSync(path.join(toolbox, 'claude'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mock)} "$@"\n`, { mode: 0o755 })

const gitconfig = path.join(root, 'gitconfig')
fs.writeFileSync(gitconfig, '[user]\n\tname = Fixture User\n\temail = fixture@example.com\n[init]\n\tdefaultBranch = main\n')
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k]
Object.assign(process.env, {
  PATH,
  SHELL: path.join(shellBin, 'sh'),
  HOME: root,
  USERPROFILE: root,
  OPEN_WALNUT_HOME: root,
  WALNUT_DAEMON_DIR: path.join(root, 'daemon'),
  WALNUT_STREAMS_DIR: path.join(root, 'streams'),
  WALNUT_DISABLE_SEARCH: '1',
  // No background AI (the Changed tab's triage would ask the mock model for JSON).
  // Suggest is a user action and still reaches the mock model.
  WALNUT_DISABLE_BACKGROUND_AI: '1',
  WALNUT_BUNDLED_STORE_DIR: path.join(root, 'bundled-store'),
  GIT_CONFIG_GLOBAL: gitconfig,
  GIT_CONFIG_NOSYSTEM: '1',
  MOCK_CLAUDE_TRANSCRIPT_DIR: path.join(root, '.claude/projects'),
  MOCK_CLAUDE_PLAIN_ECHO: '1',
  MOCK_SNAPSHOT_TURN_DELAY_MS: '300',
})
process.argv.push('--_ephemeral-child')
fs.mkdirSync(path.join(root, 'bundled-store'), { recursive: true })

// The repo and its remote.
const git = (cwd: string, args: string[]) => { inRoot(cwd); return execFileSync('git', args, { cwd, env: process.env, encoding: 'utf8', stdio: 'pipe' }) }
const project = path.join(root, 'project')
const remote = path.join(root, 'remotes/github.com/acme/widget.git')
fs.mkdirSync(project, { recursive: true })
fs.mkdirSync(remote, { recursive: true })
git(remote, ['init', '-q', '--bare', '-b', 'main'])
git(project, ['init', '-q', '-b', 'main'])
fs.writeFileSync(path.join(project, 'shared.txt'), Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join(''))
fs.writeFileSync(path.join(project, 'notes.txt'), 'first note\n')
git(project, ['add', '-A'])
git(project, ['commit', '-q', '-m', 'Initial commit'])
git(project, ['remote', 'add', 'origin', remote])
git(project, ['push', '-q', '-u', 'origin', 'main'])

// The daemon: compiled from THIS checkout into the fixture dir (dist/ is what
// production upgrades remote hosts from, so it is never touched here).
const daemonBin = path.join(root, 'daemon-bin/daemon-darwin-arm64')
const version = `walnut-daemon-session-commit-${Date.now().toString(36)}`
fs.mkdirSync(path.dirname(daemonBin), { recursive: true })
const bun = process.env.BUN_BIN ?? path.join(realHome, '.bun/bin/bun')
execFileSync(bun, ['build', '--compile', '--target=bun-darwin-arm64', '--define', `process.env.DAEMON_VERSION='${version}'`,
  path.join(repoRoot, 'src/providers/daemon-standalone.ts'), '--outfile', daemonBin], { cwd: repoRoot, stdio: 'pipe', env: { ...process.env, HOME: realHome } })
fs.writeFileSync(`${daemonBin}.version`, version)

fs.writeFileSync(path.join(root, 'config.yaml'), JSON.stringify({
  version: 1,
  defaults: { priority: 'none', platform: 'local' },
  provider: { type: 'claude-code' },
  agent: {
    main_provider: 'fixture-cli',
    main_model: 'fixture-mock',
    triage: { debounce_minutes: 0 },
  },
  providers: { 'fixture-cli': { api: 'claude-cli', claude_cli_command: path.join(repoRoot, 'tests/providers/mock-main-agent.mjs') } },
}, null, 2))
fs.mkdirSync(path.join(root, 'tasks'), { recursive: true })
fs.writeFileSync(path.join(root, 'tasks', 'tasks.json'), JSON.stringify({ version: 1, tasks: [] }, null, 2))

// Point the local daemon at the binary above before anything starts it.
const { localDaemon } = await import('../../../src/providers/local-daemon.js')
;(localDaemon as unknown as { findDaemonBinary: () => string }).findDaemonBinary = () => daemonBin

const { startServer, stopServer, armGracefulSignalExit } = await import('../../../src/web/server.js')
const apiServer = await startServer({ port: 0, dev: true })
const apiAddress = apiServer.address()
if (!apiAddress || typeof apiAddress === 'string') throw new Error('Session commit fixture did not bind a TCP port')
const apiTarget = `http://127.0.0.1:${apiAddress.port}`

const { createServer: createViteServer } = await import('vite')
const { restateOwnOrigin } = await import('../../../web/dev-proxy-origin.js')
const viteServer = await createViteServer({
  root: path.join(repoRoot, 'web'),
  cacheDir: path.join(root, 'vite-cache'),
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
// Written BEFORE Vite listens: Playwright starts the spec as soon as the port answers.
const fixture = { port, apiPort: apiAddress.port, root, project, remote, daemonVersion: version }
fs.writeFileSync(manifest, JSON.stringify(fixture))
await viteServer.listen()
console.log(`SESSION_COMMIT_READY ${JSON.stringify(fixture)}`)

let closing = false
const shutdown = async () => {
  if (closing) return
  closing = true
  await viteServer.close().catch(() => {})
  await stopServer()
  try { await localDaemon.stopIfIsolated() } catch { /* best effort */ }
  process.exit(0) // the 'exit' handler above removes the temp dir
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
// Without this the server's own SIGTERM handler drops ours and re-raises the
// signal, which kills the process with no 'exit' event and leaves the temp dir.
armGracefulSignalExit()
