/**
 * Every place in src/ that runs something on a remote host, read from the source
 * and classified by how a test server stays inside its own dirs there
 * (src/providers/remote-isolation.ts; 2026-11-06: a test server's dir probe wrote
 * into the production /tmp/open-walnut, and its installs ran with the host's real
 * HOME). A new site, or one more call in a listed place, fails here until it is
 * added with the reason it cannot write outside the test server's root.
 *
 * Kinds:
 *   own-dir    its paths come from the connection's chosen daemon dir, its start env
 *              or its install HOME, which the isolation decision sets for a test server
 *   own-root   removes only a root isOwnIsolatedRoot accepts
 *   read       reads, never writes (uname, $HOME, a status file, a reachability check)
 *   transport  the primitive itself (a tunnel, a forward, ssh with the caller's script)
 *   not-for-test-server  never runs for a test server's isolated host (named gate)
 *   gated      goes through remoteIsolationFor and refuses a host that is off
 *   local      runs ssh only to read this machine's own config (`ssh -G`)
 *   user-directed  writes where the person or the session asked (a transfer), not Walnut's own dirs
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const SITE_PATTERNS = [
  /\(\s*['"](?:ssh|scp|sftp|rsync)['"]\s*,/g,
  /(?:command|bin)\s*:\s*['"](?:ssh|scp)['"]|\.bin\s*\?\?\s*['"]ssh['"]/g,
  /\b(?:sshExec|runRemoteSh|runRemoteScript|uploadFile|pipeChunk|runSshBounded)\s*\(/g,
]

type Kind = 'own-dir' | 'own-root' | 'read' | 'transport' | 'not-for-test-server' | 'gated' | 'local' | 'user-directed'
interface Entry { count: number; kind: Kind; why: string }

/** src/providers/daemon-connection.ts, per member (the nearest member definition above the call). */
const CONNECTION: Record<string, Entry> = {
  detectRemoteArch: { count: 1, kind: 'read', why: '`uname -m`' },
  _bootStart: { count: 2, kind: 'not-for-test-server', why: 'its off() answers for an isolated daemon before anything runs' },
  runRemoteScript: { count: 2, kind: 'transport', why: 'the host server handle; that handle is only given for a shared host or the replica check' },
  uploadFile: { count: 2, kind: 'transport', why: 'writes the path its caller names; callers are listed here' },
  hostServerHandle: { count: 2, kind: 'not-for-test-server', why: 'hostServerConnected runs only for a shared host or the replica check (its own root)' },
  dialPortForward: { count: 1, kind: 'transport', why: 'a port forward, no remote command' },
  retireIsolatedDaemon: { count: 1, kind: 'own-root', why: 'buildIsolatedRetireScript behind isOwnIsolatedRoot' },
  pipeSingleStream: { count: 1, kind: 'transport', why: 'writes the path its caller names (deployBinary: the daemon dir)' },
  pipeChunk: { count: 2, kind: 'transport', why: 'writes the chunk dir its caller names (under the daemon dir)' },
  sshExec: { count: 2, kind: 'transport', why: 'the primitive: runs the script its caller builds' },
  sweepStaleIsolatedRoots: { count: 1, kind: 'own-root', why: 'buildStaleIsolatedRootSweepScript: only 16-hex test roots this user owns, no live daemon or terminal, untouched for 2 hours' },
  resolveRemoteDir: { count: 1, kind: 'own-dir', why: 'an isolated connection probes only isolatedProbeOpts (tests/providers/remote-isolation.test.ts runs it)' },
  detectServiceTakeover: { count: 1, kind: 'not-for-test-server', why: 'returns unmanaged for an isolated connection before probing the host\'s service files' },
  checkDaemonRunning: { count: 2, kind: 'own-dir', why: 'candidateDaemonDirs: only the isolated dirs; --status with dirEnv' },
  shouldUpgradeDaemon: { count: 2, kind: 'own-dir', why: 'reads the binary in the chosen daemon dir, and keeps the build that runs (the way back) there; beside it for an isolated dir (keepsDurable)' },
  trialStaged: { count: 1, kind: 'own-dir', why: 'the staged build in a throwaway walnut-proof dir with its own HOME and dirs; for an isolated connection that dir, its sweep and the runtime tree are under its own root' },
  startHeldBack: { count: 1, kind: 'own-dir', why: 'the kept copy back into the chosen daemon dir and started there; an isolated connection reads no held build (ownUpdateRecord)' },
  restoreUnstopped: { count: 1, kind: 'own-dir', why: 'the kept copy back into the dir this connection kept it from; a stored dir is never read by an isolated connection (ownUpdateRecord)' },
  startPreviousAfterFail: { count: 1, kind: 'own-dir', why: 'the daemon it replaced started again in the dir it replaced (this connection\'s own, never a stored one for an isolated connection)' },
  hostBoot: { count: 1, kind: 'read', why: 'the host\'s boot time' },
  startedAfterStop: { count: 1, kind: 'read', why: 'the pid file of the dir it replaced in, and the boot time' },
  proveStarted: { count: 1, kind: 'read', why: 'whether the pid in the dir it replaced in is that dir\'s daemon (kill -0, w_daemon)' },
  settleStartedOnLive: { count: 1, kind: 'read', why: 'daemon.version of the dir it replaced in' },
  readBackUnreadOnce: { count: 1, kind: 'not-for-test-server', why: 'an isolated connection reads no update record (ownUpdateRecord), so it has no update to read back' },
  reviveRemoteService: { count: 1, kind: 'not-for-test-server', why: 'revives the host\'s OS service; IS_EPHEMERAL returns before anything runs' },
  prewarmRemoteFolds: { count: 3, kind: 'own-dir', why: 'daemonDir = the chosen dir, env = dirEnv, bun probe with bunScriptOpts' },
  acpTurnsOpen: { count: 1, kind: 'read', why: 'reads acp-busy.json in the chosen daemon dir' },
  updateManagedDaemon: { count: 3, kind: 'not-for-test-server', why: 'only for an OS-service daemon; an isolated one is never managed (detectServiceTakeover)' },
  stopUnmanagedDaemon: { count: 1, kind: 'own-dir', why: 'buildDaemonStopCmd(the chosen daemon dir), which proves the pid is that dir\'s daemon' },
  probeOrInstallBun: { count: 3, kind: 'own-dir', why: 'bunScriptOpts: the install runs with HOME and BUN_INSTALL under the isolated install home' },
  deployWalnutFile: { count: 5, kind: 'own-dir', why: 'the slot is in the chosen daemon dir; the host server install is not looked at for an isolated daemon' },
  deployWalnutFileDelta: { count: 3, kind: 'own-dir', why: 'the slot and its delta file, in the chosen daemon dir' },
  seedHostFileFromDaemon: { count: 1, kind: 'not-for-test-server', why: 'a host server install step (shared host or the replica check only)' },
  deployBinary: { count: 4, kind: 'own-dir', why: 'mkdir, version, unpack: all in the chosen daemon dir' },
  pipeChunked: { count: 9, kind: 'own-dir', why: 'its chunk dir and target, under the chosen daemon dir' },
  deploySource: { count: 3, kind: 'own-dir', why: 'daemon.cjs and its sidecars, into the chosen daemon dir' },
  startDaemon: { count: 2, kind: 'own-dir', why: 'buildDaemonStartCmd with dirEnv: isolatedDaemonEnv (tests/providers/daemon-isolated-connection.test.ts captures it)' },
  createTunnel: { count: 1, kind: 'transport', why: 'a port forward, no remote command' },
}

/** Every other file in src/ with a site, with how many. */
const FILES: Record<string, Entry> = {
  'src/providers/remote-sh.ts': { count: 4, kind: 'transport', why: 'runSshBounded and runRemoteSh themselves: ssh with the caller\'s args, `sh -s` with the caller\'s script' },
  'src/core/host-server/manager.ts': { count: 13, kind: 'not-for-test-server', why: 'acts only on a host handle hostServerConnected gave it (shared host or the replica check\'s own root)' },
  'src/core/plugin-jobs/manager.ts': { count: 2, kind: 'not-for-test-server', why: 'plugin jobs do not run on a test server (pluginJobsOffReason); bundles go to the daemon\'s own dir' },
  'src/core/plugins/plugin-hosts.ts': { count: 1, kind: 'gated', why: 'runOnPluginHost refuses a host whose isolation is off' },
  'src/core/hosts/ssh-cert-expiry-alert.ts': { count: 1, kind: 'read', why: '`ssh host true`: does the sign-in work' },
  'src/providers/ssh-credential-evidence.ts': { count: 2, kind: 'local', why: '`ssh -G`, reads this machine\'s ssh config' },
  'src/core/hosts/ssh-key-of.ts': { count: 1, kind: 'local', why: '`ssh -G <alias>`, reads which key this machine\'s ssh offers a host (first-run walkthrough)' },
  'src/core/hosts/ssh-resolve.ts': { count: 1, kind: 'local', why: '`ssh -G <alias>`: reads this machine\'s ssh config to prefill Add host' },
  'src/providers/stream-lane.ts': { count: 2, kind: 'transport', why: 'a port forward to the connection\'s daemon (`cat >/dev/null`); one spawn, the other call its test seam (deps.spawn)' },
  'src/providers/transfer-core.ts': { count: 2, kind: 'user-directed', why: 'a task transfer the person asked for: `ssh true` and an scp read into a local temp file' },
  'src/web/terminal/dtach-lifecycle.ts': { count: 1, kind: 'gated', why: 'its socket dir is the test server\'s term dir (REMOTE_DTACH_SOCKET_DIR)' },
  'src/web/terminal/dtach-provision.ts': { count: 2, kind: 'gated', why: 'probe and install use REMOTE_DTACH_OWN_BIN under the test server\'s root' },
  'src/web/terminal/spawn.ts': { count: 2, kind: 'gated', why: 'resolveSshTarget refuses a host that is off; sockets in the test server\'s term dir' },
}

function codeLines(file: string): string[] {
  return fs.readFileSync(path.join(ROOT, file), 'utf-8').split('\n').map((l) => {
    const t = l.trim()
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') ? '' : l
  })
}
function sitesIn(line: string): number {
  return SITE_PATTERNS.reduce((n, re) => n + (line.match(re)?.length ?? 0), 0)
}
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name)
    if (e.isDirectory()) walk(rel, out)
    else if (e.name.endsWith('.ts')) out.push(rel)
  }
  return out
}

describe('remote write paths ratchet', () => {
  it('every file with a remote-exec site is listed with its count', () => {
    const found: Record<string, number> = {}
    for (const f of walk('src')) {
      const n = codeLines(f).reduce((s, l) => s + sitesIn(l), 0)
      if (n) found[f] = n
    }
    const listed = { ...Object.fromEntries(Object.entries(FILES).map(([f, e]) => [f, e.count])), 'src/providers/daemon-connection.ts': Object.values(CONNECTION).reduce((s, e) => s + e.count, 0) }
    expect(found, 'a remote-exec site appeared or went: classify it in this file (how does a test server stay in its own root there?)').toEqual(listed)
  })

  it('every remote-exec site in DaemonConnection is listed under its member', () => {
    const member = /^ {2}(?:(?:private|public|protected|static|async|readonly|override)\s+)*(?:get\s+|set\s+)?(\w+)\s*(?:<[^>]*>)?\(/
    const found: Record<string, number> = {}
    let cur = '(top level)'
    for (const line of codeLines('src/providers/daemon-connection.ts')) {
      const m = line.match(member)
      if (m) cur = m[1]
      const n = sitesIn(line)
      if (n) found[cur] = (found[cur] ?? 0) + n
    }
    expect(found, 'a DaemonConnection member gained or lost a remote-exec site: classify it in this file').toEqual(Object.fromEntries(Object.entries(CONNECTION).map(([k, e]) => [k, e.count])))
  })

  it('the gates the classification leans on are still in the source', () => {
    const dc = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-connection.ts'), 'utf-8')
    expect(dc).toMatch(/isolatedProbeOpts\(iso\)/)
    expect(dc).toMatch(/if \(this\.isolation\.mode === 'isolated'\) return \{ managed: false/)
    expect(dc).toMatch(/if \(this\.isolation\.mode === 'isolated'\) return 'it is an isolated daemon that ends with the Walnut that started it'/)
    expect(dc).toMatch(/iso\.mode === 'shared' \|\| \(iso\.mode === 'isolated' && iso\.replica\)\) void import\('\.\.\/core\/host-server\/index\.js'\)/)
    expect(dc).toMatch(/isolatedDaemonEnv\(isolatedRootOfDaemonDir\(this\._remoteDir\), iso\.key\)/)
    // The update records on disk are the real server's: every read of one goes through the one
    // helper, which reads only for a real server's connection.
    expect(dc).toMatch(/private ownUpdateRecord<T>\(read: \(key: string\) => Promise<T \| null>\): Promise<T \| null> \{\n {4}return this\.isolation\.mode === 'shared' \?/)
    const reads = dc.match(/(?:readBuildBackoff|unreadUpdates\.read|pendingReplaces\.read)\(/g) ?? []
    const helped = dc.match(/this\.ownUpdateRecord\(\(k\) => (?:readBuildBackoff|unreadUpdates\.read|pendingReplaces\.read)\(k\)\)/g) ?? []
    expect(reads.length).toBeGreaterThan(0)
    expect(helped.length, 'an update record read that is not through ownUpdateRecord').toBe(reads.length)
    expect(dc).toMatch(/opts\.isolated = \{ root, runtimeDir: isolatedLayout\(root\)\.runtimeDir \}/)
    expect(fs.readFileSync(path.join(ROOT, 'src/core/plugin-jobs/index.ts'), 'utf-8')).toMatch(/plugin jobs do not run on a test server/)
    expect(fs.readFileSync(path.join(ROOT, 'src/core/plugins/plugin-hosts.ts'), 'utf-8')).toMatch(/remoteIsolationFor\(/)
    expect(fs.readFileSync(path.join(ROOT, 'src/web/terminal/spawn.ts'), 'utf-8')).toMatch(/remoteIsolationFor\(/)
    // A test daemon's identity never reaches its sessions (a nested test server's daemon would claim it).
    for (const twin of ['src/providers/daemon-standalone.ts', 'src/providers/daemon-source.ts']) {
      const src = fs.readFileSync(path.join(ROOT, twin), 'utf-8')
      for (const k of ['WALNUT_DAEMON_ISOLATED_FOR', 'WALNUT_DAEMON_ORPHAN_EXIT_MS', 'WALNUT_INSTALL_HOME', 'WALNUT_RUNTIME_DIR', 'WALNUT_DAEMON_STATE_DIR']) expect(src, `${twin} ${k}`).toContain(`${k}: undefined,`)
    }
    const local = fs.readFileSync(path.join(ROOT, 'src/providers/local-daemon.ts'), 'utf-8')
    for (const k of ['WALNUT_DAEMON_ISOLATED_FOR', 'WALNUT_DAEMON_ORPHAN_EXIT_MS', 'WALNUT_INSTALL_HOME']) expect(local).toContain(`delete env.${k}`)
  })
})
