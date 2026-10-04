/**
 * A real cloud companion (WALNUT_CLOUD_MODE=1 replica) in a child process, set
 * up to host the primary's sessions through /daemon-tunnel, plus the pairing a
 * primary needs to find it. Shared by tests/e2e/cloud-box-tunnel-e2e.test.ts and
 * the Playwright fixture tests/e2e/browser/cloud-host-server.ts.
 *
 * Everything lives under one throwaway base: the replica's HOME, data dir,
 * its own daemon dir and the tunnel daemon dir. auth.json is written fresh
 * (five records, random tokens and ids), never copied; no fixture carries a pid.
 *
 * `restart()` is a companion restart as systemd does it with KillMode=process:
 * the server process ends, the box daemon and its CLIs stay, and a new server
 * starts over the same dirs.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { endTunnelSessionGroups } from './cloud-box-daemon-build.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
const MOCK_CLI = path.join(REPO_ROOT, 'tests/providers/mock-claude.mjs')

export interface ReplicaTokens {
  /** The Mac's device token (rides the `cloud` git remote). */
  mac: string
  /** A second Mac paired with the same companion (`mac-second`). */
  secondMac: string
  /** A phone (it reports an iPhone, as the iOS app does on launch). */
  phone: string
  /** `bridge-local`: the primary's machine credential, the tunnel's only key. */
  primaryMachine: string
  /** `bridge-devbox`: another host's machine credential. */
  otherMachine: string
}

/** Which daemon build the box's tunnel daemon runs (default: whatever the server picks). */
export interface DaemonRelease { binary: string; version?: string }

/** The device ids auth.json is seeded with (minted at pairing; see core/device-actor.ts). */
export type ReplicaIds = Record<'mac-primary' | 'mac-second' | 'my-phone' | 'bridge-local' | 'bridge-devbox', string>

/** One auth.json record as a test reads it (never the token hash). */
export interface ReplicaDevice {
  name: string
  id?: string
  kind?: string
  platform?: string
  ownerId?: string
  daemonKey?: string
  tunnelDaemon?: { key?: string }
}

export interface ReplicaOptions {
  /**
   * The paired device that owns the two machine credentials, as a companion
   * with ownership recorded has it. Absent: they predate ownership (no owner),
   * as on a companion upgraded from an older build.
   */
  machineOwner?: 'mac-primary' | 'mac-second'
}

export interface CloudBoxReplica {
  /** The CURRENT server's port (a restart changes it; put a proxy in front for a fixed address). */
  readonly port: number
  tokens: ReplicaTokens
  /** The ids the records were seeded with (a re-pairing by anyone but the device itself mints a new one). */
  ids: ReplicaIds
  box: { home: string; data: string; daemonDir: string; tunnelDir: string; projects: string }
  log: () => string
  /**
   * A session's stream file, in the unkeyed dir or in the keyed dir of `owner`:
   * a seeded device name (its seeded id) or a device id.
   */
  streamFile: (sid: string, owner?: string) => string
  /** The tunnel daemon dir that serves `owner` (as above; none = unkeyed, a credential from before ownership). */
  daemonDirOf: (owner?: string) => string
  /** The tunnel daemon as its files describe it (pid, instance id). */
  tunnelDaemon: (owner?: string) => { pid: number | null; instanceId: string | null }
  /** The replica's auth.json as it is now. */
  devices: () => ReplicaDevice[]
  /** End the server only (SIGTERM, as systemd), then start a new one; `release` swaps the daemon build. */
  restart: (release?: DaemonRelease) => Promise<void>
  stop: () => Promise<void>
  /** Synchronous last resort for a parent that is exiting: the box daemon, its CLIs and the replica. */
  killNow: () => void
}

const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const token = () => crypto.randomBytes(16).toString('hex')
const deviceId = () => `d${crypto.randomBytes(8).toString('hex')}`

export function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k]
  return env
}

function readInt(file: string): number | null {
  try { const n = Number(fs.readFileSync(file, 'utf-8').trim()); return Number.isInteger(n) && n > 1 ? n : null } catch { return null }
}

export async function startCloudBoxReplica(base: string, release?: DaemonRelease, opts: ReplicaOptions = {}): Promise<CloudBoxReplica> {
  const tokens: ReplicaTokens = { mac: token(), secondMac: token(), phone: token(), primaryMachine: token(), otherMachine: token() }
  const box = {
    home: path.join(base, 'box', 'home'),
    data: path.join(base, 'box', 'data'),
    daemonDir: path.join(base, 'box', 'replica-daemon'),
    tunnelDir: path.join(base, 'box', 'tunnel-daemon'),
    projects: path.join(base, 'box', 'home', 'projects'),
  }
  for (const d of [box.data, box.daemonDir, path.join(box.projects, 'alpha'), path.join(box.projects, 'beta'), path.join(box.home, '.toolbox', 'bin'), path.join(base, 'hub')]) {
    await fsp.mkdir(d, { recursive: true })
  }
  await fsp.writeFile(path.join(box.projects, 'alpha', 'README.md'), '# alpha on the box\n')
  // The box's `claude`: the mock CLI, answering --version like a current release.
  await fsp.writeFile(path.join(box.home, '.toolbox', 'bin', 'claude'),
    `#!/bin/sh\n[ "$1" = "--version" ] && { echo "9.9.9 (Claude Code)"; exit 0; }\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(MOCK_CLI)} "$@"\n`, { mode: 0o755 })
  await fsp.writeFile(path.join(box.data, 'config.yaml'),
    `version: 1\nuser:\n  name: Box\ncloud:\n  exec:\n    enabled: true\n    cwd_roots:\n      - ${box.projects}\n`)
  const now = new Date().toISOString()
  const ids: ReplicaIds = { 'mac-primary': deviceId(), 'mac-second': deviceId(), 'my-phone': deviceId(), 'bridge-local': deviceId(), 'bridge-devbox': deviceId() }
  // Owned, as a current build records it: the owner's id on each credential and
  // the owner's own tunnel daemon. The phone's platform is the one it claimed.
  const ownerId = opts.machineOwner ? ids[opts.machineOwner] : undefined
  const owned = ownerId ? { ownerId, daemonKey: ownerId } : {}
  const ownerOf = (name: string) => (opts.machineOwner === name ? { tunnelDaemon: { key: ownerId } } : {})
  await fsp.writeFile(path.join(box.data, 'auth.json'), JSON.stringify({ devices: [
    { name: 'mac-primary', id: ids['mac-primary'], tokenHash: sha(tokens.mac), createdAt: now, ...ownerOf('mac-primary') },
    { name: 'mac-second', id: ids['mac-second'], tokenHash: sha(tokens.secondMac), createdAt: now, ...ownerOf('mac-second') },
    { name: 'my-phone', id: ids['my-phone'], tokenHash: sha(tokens.phone), createdAt: now, platform: 'ios', info: { model: 'iPhone17,1', os: 'iOS 26.1', reportedAt: now } },
    { name: 'bridge-local', id: ids['bridge-local'], tokenHash: sha(tokens.primaryMachine), createdAt: now, kind: 'machine', ...owned },
    { name: 'bridge-devbox', id: ids['bridge-devbox'], tokenHash: sha(tokens.otherMachine), createdAt: now, kind: 'machine', ...owned },
  ] }), { mode: 0o600 })

  const script = path.join(base, 'boot-replica.mts')
  // Refuses to boot unless its data dir is exactly the throwaway one.
  await fsp.writeFile(script, `
const c = await import(${JSON.stringify(path.join(REPO_ROOT, 'src/constants.ts'))})
if (c.WALNUT_HOME !== ${JSON.stringify(box.data)} || !c.CLOUD_MODE) { process.stderr.write('REFUSING: wrong home ' + c.WALNUT_HOME + '\\n'); process.exit(3) }
const { startServer, stopServer, armGracefulSignalExit } = await import(${JSON.stringify(path.join(REPO_ROOT, 'src/web/server.ts'))})
const server = await startServer({ port: 0, dev: true })
const addr = server.address()
process.stdout.write('WALNUT_PORT=' + (typeof addr === 'object' && addr ? addr.port : addr) + '\\n')
let closing = false
const close = async () => { if (closing) return; closing = true; try { await stopServer() } catch {} process.exit(0) }
process.on('SIGTERM', close)
process.on('SIGINT', close)
// Our handler owns the exit, so startServer() must not re-raise the signal first.
armGracefulSignalExit()
`)
  let log = ''

  async function boot(rel: DaemonRelease | undefined): Promise<{ proc: ChildProcess; port: number }> {
    const proc = spawn(TSX, [script], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        WALNUT_CLOUD_MODE: '1',
        OPEN_WALNUT_HOME: box.data,
        HOME: box.home,
        USERPROFILE: box.home,
        WALNUT_HOME_OVERRIDE: box.home,
        SHELL: '/bin/sh',
        WALNUT_DAEMON_DIR: box.daemonDir,
        WALNUT_TUNNEL_DAEMON_DIR: box.tunnelDir,
        ...(rel ? { WALNUT_TUNNEL_DAEMON_BINARY: rel.binary } : {}),
        // A runtime-versioned test build reports this (cloud-box-daemon-build.ts).
        ...(rel?.version ? { DAEMON_VERSION: rel.version } : {}),
        WALNUT_STREAMS_DIR: '',
        WALNUT_LEGACY_STREAMS_DIR: path.join(base, 'legacy-streams'),
        WALNUT_SPAWN_JOURNAL: path.join(base, 'box', 'spawn-journal.jsonl'),
        WALNUT_GIT_HUB_DIR: path.join(base, 'hub'),
        MOCK_CLAUDE_TRANSCRIPT_DIR: path.join(box.home, '.claude', 'projects'),
        WALNUT_LOCAL_CLAUDE_PROBE: '0',
        WALNUT_DISABLE_BACKGROUND_AI: '1',
        WALNUT_DISABLE_SEARCH: '1',
        VITEST: '', VITEST_WORKER_ID: '', VITEST_POOL_ID: '', NODE_ENV: 'production',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.stderr!.on('data', (b: Buffer) => { log = (log + b.toString()).slice(-400_000) })
    const port = await new Promise<number>((resolve, reject) => {
      let out = ''
      const t = setTimeout(() => reject(new Error(`replica did not report a port in 150s\n${log.slice(-3000)}`)), 150_000)
      proc.stdout!.on('data', (b: Buffer) => {
        out += b.toString()
        const m = /WALNUT_PORT=(\d+)/.exec(out)
        if (m) { clearTimeout(t); resolve(Number(m[1])) }
      })
      proc.once('exit', (code) => { clearTimeout(t); reject(new Error(`replica exited early (${code})\n${log.slice(-3000)}`)) })
    })
    return { proc, port }
  }

  /** The server process only (its own daemon dies with it by watchdog; the tunnel daemon stays). */
  async function endServer(proc: ChildProcess): Promise<void> {
    if (proc.exitCode !== null || proc.signalCode !== null) return
    const exited = new Promise<void>((r) => proc.once('exit', () => r()))
    proc.kill('SIGTERM')
    await Promise.race([exited, new Promise((r) => setTimeout(r, 30_000))])
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
  }

  /** Same layout as tunnelDaemonDir / tunnelStreamsDir (src/providers/cloud-tunnel-daemon.ts). */
  const keyOf = (owner: string) => (ids as Record<string, string>)[owner] ?? owner
  const daemonDirOf = (owner?: string) => (owner ? path.join(`${box.tunnelDir}.by-device`, keyOf(owner), 'daemon') : box.tunnelDir)
  const streamsDirOf = (owner?: string) => (owner ? path.join(`${box.tunnelDir}.by-device`, keyOf(owner), 'streams') : `${box.tunnelDir}-streams`)
  /** Every tunnel daemon dir that exists: the unkeyed one and each owner's. */
  function allTunnelDirs(): string[] {
    let owners: string[] = []
    try { owners = fs.readdirSync(`${box.tunnelDir}.by-device`) } catch { /* none keyed */ }
    return [box.tunnelDir, ...owners.map((o) => daemonDirOf(o))]
  }

  /** The tunnel daemons are persistent by design: stop each through its pid file, then its CLIs. */
  async function stopTunnelDaemons(): Promise<void> {
    for (const dir of allTunnelDirs()) {
      const pid = readInt(path.join(dir, 'daemon.pid'))
      if (pid) {
        try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
        for (let i = 0; i < 100; i++) {
          try { process.kill(pid, 0) } catch { break }
          await new Promise((r) => setTimeout(r, 100))
        }
      }
      endTunnelSessionGroups(dir)
    }
  }

  let current = await boot(release)
  return {
    get port() { return current.port },
    tokens, ids, box,
    log: () => log,
    streamFile: (sid, owner) => path.join(streamsDirOf(owner), `${sid}.jsonl`),
    daemonDirOf,
    tunnelDaemon: (owner) => {
      const dir = daemonDirOf(owner)
      let instanceId: string | null = null
      try { instanceId = fs.readFileSync(path.join(dir, 'daemon.instance'), 'utf-8').trim() || null } catch { /* none */ }
      return { pid: readInt(path.join(dir, 'daemon.pid')), instanceId }
    },
    devices: () => {
      const raw = JSON.parse(fs.readFileSync(path.join(box.data, 'auth.json'), 'utf-8')) as { devices: Array<Record<string, unknown>> }
      return raw.devices.map((d) => {
        const out: ReplicaDevice = { name: String(d.name) }
        for (const k of ['id', 'kind', 'platform', 'ownerId', 'daemonKey'] as const) if (typeof d[k] === 'string') out[k] = d[k] as string
        if (d.tunnelDaemon && typeof d.tunnelDaemon === 'object') out.tunnelDaemon = d.tunnelDaemon as { key?: string }
        return out
      })
    },
    restart: async (rel) => {
      await endServer(current.proc)
      current = await boot(rel ?? release)
    },
    stop: async () => {
      await stopTunnelDaemons()
      await endServer(current.proc)
    },
    killNow: () => {
      for (const dir of allTunnelDirs()) {
        const pid = readInt(path.join(dir, 'daemon.pid'))
        if (pid) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
        endTunnelSessionGroups(dir)
      }
      if (current.proc.exitCode === null) { try { current.proc.kill('SIGTERM') } catch { /* gone */ } }
    },
  }
}

/**
 * Pair a primary data dir with the companion at `domain` (host:port): the
 * `cloud` remote carries the Mac's device token, and the machine credential is
 * cached the way a first bridge push leaves it.
 */
export async function seedPrimaryPairing(
  walnutHome: string,
  domain: string,
  tokens: Pick<ReplicaTokens, 'mac' | 'primaryMachine'>,
  opts: { as?: 'mac-primary' | 'mac-second'; secondMac?: string; cachedMachineToken?: boolean } = {},
): Promise<void> {
  const deviceToken = opts.as === 'mac-second' ? opts.secondMac! : tokens.mac
  execFileSync('git', ['init', '-q', walnutHome], { env: gitEnv() })
  execFileSync('git', ['-C', walnutHome, 'remote', 'add', 'cloud', `http://mac:${deviceToken}@${domain}/git/data.git`], { env: gitEnv() })
  await fsp.mkdir(path.join(walnutHome, 'sync'), { recursive: true })
  const cache = opts.cachedMachineToken === false ? {} : { 'bridge-local': tokens.primaryMachine }
  await fsp.writeFile(path.join(walnutHome, 'sync', 'bridge-tokens.json'), JSON.stringify(cache), { mode: 0o600 })
}
