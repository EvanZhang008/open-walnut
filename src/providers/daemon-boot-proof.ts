/**
 * The trial run before a daemon service is changed (`walnut daemon install|update`, every
 * path: SSH, the host network's runner, this machine's own LocalDaemon): start the new
 * executable as a daemon in a throwaway dir, wait for it to listen, see it still alive a
 * moment later, stop it and remove the dir. Only then is the old daemon asked to stop.
 * Before this, the only check was `__daemon --version`, which a daemon that dies in its
 * startup passes (2026-11-04: a host network Mac's update stopped the old daemon for a new
 * one that never served, and nothing came back until its owner logged in again).
 *
 * One daemon per daemon dir (daemon-instance-lock.ts), so the trial cannot run beside the
 * live one under the same dir; it gets dirs of its own and nothing of this process's env:
 *   HOME                        ~/.claude, the spawn journal, the streams and net state, task dirs
 *   WALNUT_DAEMON_DIR           its runtime files and its instance lock (a lock port of its own)
 *   WALNUT_DAEMON_STATE_DIR     --service's registry, handover, hooks, triggers, cron supervision
 *   WALNUT_STREAMS_DIR          no session's streams to adopt or clean up
 *   WALNUT_LEGACY_STREAMS_DIR   no real /tmp/open-walnut-streams to migrate
 *   WALNUT_SPAWN_JOURNAL, WALNUT_JOURNAL_DIR, WALNUT_TASK_DIR_ROOT, XDG_*, TMPDIR
 * so it adopts no session, starts no walnut-net (no config in its state) and no cron job,
 * and claims no CLI. It is this process's own child in a process group of its own, and only
 * that group is ever signalled.
 *
 * It ends by itself too: WALNUT_DAEMON_LIFETIME_SECONDS, a little past the proof window, so a
 * trial whose prover died (the CLI, the server, the SSH session) does not stay for good, and
 * proof dirs such a trial left behind are swept before the next one (2026-11-04 review: a
 * --service trial has no parent watchdog, and a full daemon stayed in /tmp/walnut-proof-*).
 *
 * `serve`: the version will run as a host's one Walnut service (src/binary/service-entry.ts), so it
 * is proven as one: a throwaway follower spec (its own data and run dirs, a free port, a leader
 * that never comes), the mode file naming this executable, a launcher dir; it must write the
 * launcher's ready mark (sessions adopted, its door answering, GET /api/config answered), the mark
 * the launcher commits a version by, as the Walnut server (`serves=walnut-serve`): a daemon program
 * under a launcher writes that mark too, so a `--service` start that fell back to the daemon (the
 * entry refused the spec, a mis-routed main) would otherwise pass a proof of a path it never ran.
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { singleFile } from '../lib/single-file.js'

export interface BootProofOptions {
  executable: string
  args: string[]
  /** The PATH the service gives it. */
  path: string
  /** How long it may take to listen (its port file). */
  waitMs?: number
  /** How long it must stay up after that. */
  aliveMs?: number
  /** Where the throwaway dir goes: short, so a socket path under it fits macOS's 104 bytes. */
  base?: string
  /** Set after the isolated env, never over its dirs: the compiled walnut file's runtime tree (WALNUT_RUNTIME_DIR; trialRuntimeDir when not given). */
  env?: Record<string, string>
  /** Prove it as the host's one Walnut service (the header). */
  serve?: boolean
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

/** The files a `--service` start reads to run as the host's one Walnut service, in a proof's dirs. */
async function writeServeProof(dir: (name: string) => string, executable: string): Promise<string> {
  const leader = dir('leader')
  const data = dir('w')
  const port = await freePort()
  await fs.mkdir(path.join(dir('s'), 'host-server'), { recursive: true, mode: 0o700 })
  await fs.mkdir(path.join(dir('s'), 'launcher'), { recursive: true, mode: 0o700 })
  const spec = {
    v: 1, home: leader, walnutId: 'boot-proof', command: executable, args: [], cwd: data, log: dir('follower.log'), port, settings: {},
    env: {
      OPEN_WALNUT_HOME: data, WALNUT_DAEMON_DIR: dir('r'), WALNUT_HOST_SERVER: '1', WALNUT_HOST_SERVER_PORT: String(port),
      WALNUT_LEADER_HOME: leader, WALNUT_WALNUT_ID: 'boot-proof', WALNUT_HOST_LABEL: 'boot proof', WALNUT_NO_AUTO_UPDATE: '1',
      // A replica's placement is the host by default (server-role.ts).
      WALNUT_ROLE: 'replica', WALNUT_HOST_KEY: 'boot-proof',
    },
  }
  await fs.writeFile(path.join(dir('s'), 'host-server', 'server-bootproof.json'), JSON.stringify({ spec, token: crypto.randomBytes(32).toString('hex') }), { mode: 0o600 })
  await fs.writeFile(path.join(dir('s'), 'service-mode.json'), JSON.stringify({ v: 1, home: leader, exe: executable }), { mode: 0o600 })
  return path.join(dir('s'), 'launcher')
}

/**
 * Where a trial of the compiled walnut file finds its runtime tree (WALNUT_RUNTIME_DIR, the
 * parent of one tree per build): beside this process's own tree when it is the compiled file
 * (`walnut daemon update` runs as the build it installs, so that tree is complete), else this
 * process's own WALNUT_RUNTIME_DIR, else where the account's daemon unpacks one. 2026-11-04
 * review: the CLI's trial got none, so the compiled file unpacked its whole runtime into the
 * throwaway HOME on every update, which ate the 60 s listen window on a slow Mac (a false "did
 * not listen" holds the update) and /tmp space. A daemon that is no compiled file ignores it.
 */
export function trialRuntimeDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), own: string | null = singleFile()?.root ?? null): string {
  if (own) return path.dirname(own)
  if (env.WALNUT_RUNTIME_DIR && path.isAbsolute(env.WALNUT_RUNTIME_DIR)) return path.resolve(env.WALNUT_RUNTIME_DIR)
  const data = env.OPEN_WALNUT_HOME && path.isAbsolute(env.OPEN_WALNUT_HOME) ? env.OPEN_WALNUT_HOME : path.join(home, '.open-walnut')
  return path.join(data, 'local', 'runtime')
}

/** As long as a started service gets to answer (daemon-service-cli.ts SERVICE_READY_WAIT_MS): a slow first start is not a broken build. */
export const BOOT_PROOF_WAIT_MS = 60_000
export const BOOT_PROOF_ALIVE_MS = 3_000
const STOP_WAIT_MS = 10_000
const POLL_MS = 100
/** Past its proof window and stop, a trial ends by itself (the daemon twins read this). */
const LIFETIME_MARGIN_S = 30
/** A proof dir this old whose daemon is gone was left by a prover that died. */
export const STALE_PROOF_MS = 15 * 60_000

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A serve proof's verdict when the file ran as the session daemon instead (its ready mark has no `serves=walnut-serve`). */
export const SERVED_AS_DAEMON = 'it wrote the launcher\'s ready mark as the session daemon, not as the Walnut service'

/**
 * The proof of a version about to be staged, as the mode file says it will run: `asked`, its
 * Walnut asked for the service with this update; `carried`, the mode came over from the version
 * before with no word (another Walnut's update, an older leader). A carried mode on a file that
 * runs only as the session daemon (a daemon-only binary never reads the mode) is no failure of
 * the build: the mode goes (`dropMode`) and the file is proven as the daemon it runs as (review
 * A3b S34-L5). An asked one must serve.
 */
export async function proveStagedBoot(o: BootProofOptions & { mode: 'asked' | 'carried' | null; dropMode: () => void }, prove: (o: BootProofOptions) => Promise<string | null> = proveDaemonBoot): Promise<string | null> {
  const { mode, dropMode, ...proof } = o
  const why = await prove({ ...proof, serve: mode !== null })
  if (mode !== 'carried' || !why?.startsWith(SERVED_AS_DAEMON)) return why
  dropMode()
  return prove({ ...proof, serve: false })
}

/** null when the executable served as a daemon; else why not, in a sentence. */
export async function proveDaemonBoot(o: BootProofOptions): Promise<string | null> {
  const first = await trial(o)
  // A lock port taken by something else (one in twelve thousand: the port is a hash of the
  // dir) is the trial dir's bad luck, not the build's: once more, in a dir of another name.
  return first && /\block\b/i.test(first) ? trial(o) : first
}

async function trial(o: BootProofOptions): Promise<string | null> {
  await sweepProofDirs(o.base ?? '/tmp')
  const root = await fs.mkdtemp(path.join(o.base ?? '/tmp', 'walnut-proof-'))
  const dir = (name: string) => path.join(root, name)
  const home = dir('h')
  const runtime = dir('d')
  const log = dir('out.log')
  let child: ReturnType<typeof spawn> | null = null
  // Set from the child's own events, so read through the object (never narrowed away).
  const end: { exited: string | null } = { exited: null }
  try {
    await fs.mkdir(home, { mode: 0o700 })
    await fs.mkdir(dir('tmp'), { mode: 0o700 })
    const env: Record<string, string> = {
      HOME: home, PATH: o.path, LANG: process.env.LANG ?? 'C', TMPDIR: dir('tmp'),
      WALNUT_DAEMON_DIR: runtime, WALNUT_DAEMON_STATE_DIR: dir('s'),
      WALNUT_STREAMS_DIR: dir('st'), WALNUT_LEGACY_STREAMS_DIR: dir('ls'),
      WALNUT_SPAWN_JOURNAL: dir('spawn-journal.jsonl'), WALNUT_JOURNAL_DIR: dir('j'), WALNUT_TASK_DIR_ROOT: dir('t'),
      XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
      WALNUT_DAEMON_LIFETIME_SECONDS: String(Math.ceil(((o.waitMs ?? BOOT_PROOF_WAIT_MS) + (o.aliveMs ?? BOOT_PROOF_ALIVE_MS)) / 1000) + LIFETIME_MARGIN_S),
    }
    for (const key of ['USER', 'LOGNAME', 'SHELL']) if (process.env[key]) env[key] = process.env[key]!
    const launcherDir = o.serve ? await writeServeProof(dir, o.executable) : null
    if (launcherDir) env.WALNUT_LAUNCHER_DIR = launcherDir
    for (const [key, value] of Object.entries(o.env ?? {})) if (!(key in env)) env[key] = value
    env.WALNUT_RUNTIME_DIR ??= trialRuntimeDir()
    const out = await fs.open(log, 'a', 0o600)
    let spawned: Promise<void>
    try {
      const started = child = spawn(o.executable, o.args, { cwd: home, env, detached: true, stdio: ['ignore', out.fd, out.fd] })
      // Listened for before any await: 'spawn' may fire while the log is being closed.
      started.once('exit', (code, signal) => { end.exited = signal ? `was ended by ${signal}` : `exited with ${code}` })
      // Handled at once: a failed spawn rejects while the log is being closed, before any later await.
      spawned = new Promise<void>((resolve, reject) => { started.once('spawn', resolve); started.on('error', reject) })
        .catch((error: Error) => { end.exited = `could not be started (${error.message})` })
    } finally { await out.close() }
    await spawned

    // Monotonic: a Mac that sleeps mid-trial must not read "did not listen within 60 s" on waking (2026-11-04 review).
    const deadline = performance.now() + (o.waitMs ?? BOOT_PROOF_WAIT_MS)
    let listening = false
    while (!end.exited && performance.now() < deadline) {
      if (launcherDir) {
        // The service: the launcher's ready mark, which it writes (whole, by rename) only once it serves.
        const mark = await fs.readFile(path.join(launcherDir, 'ready'), 'utf8').catch(() => '')
        if (mark) {
          if (!/^serves=walnut-serve$/m.test(mark)) return `${SERVED_AS_DAEMON}${await said(log)}`
          listening = true
          break
        }
      } else {
        const port = Number((await fs.readFile(path.join(runtime, 'daemon.port'), 'utf8').catch(() => '')).trim())
        if (Number.isInteger(port) && port > 0 && port <= 65535) { listening = true; break }
      }
      await pause(POLL_MS)
    }
    const what = launcherDir ? 'was ready as the Walnut service' : 'listened'
    if (end.exited) return `it ${end.exited} before it ${what}${await said(log)}`
    if (!listening) return `it did not ${launcherDir ? 'write its ready mark as the Walnut service' : 'listen'} within ${Math.round((o.waitMs ?? BOOT_PROOF_WAIT_MS) / 1000)} s${await said(log)}`
    const until = performance.now() + (o.aliveMs ?? BOOT_PROOF_ALIVE_MS)
    while (!end.exited && performance.now() < until) await pause(POLL_MS)
    if (end.exited) return `it ${what}, then ${end.exited}${await said(log)}`
    return null
  } finally {
    if (child) await stop(child, () => end.exited !== null)
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Its own group only, and only while the leader (this process's child, pid > 1) has not
 * exited: a live leader keeps its group id from being anybody else's. The daemon may have
 * started a child of its own (a login shell probe), so the whole group is signalled.
 */
async function stop(child: ReturnType<typeof spawn>, gone: () => boolean): Promise<void> {
  const pid = child.pid
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) return
  const signal = (sig: NodeJS.Signals) => { if (!gone()) try { process.kill(-pid, sig) } catch { /* the group is gone */ } }
  signal('SIGTERM')
  const deadline = performance.now() + STOP_WAIT_MS
  while (!gone() && performance.now() < deadline) await pause(POLL_MS)
  signal('SIGKILL')
  const after = performance.now() + 2_000
  while (!gone() && performance.now() < after) await pause(POLL_MS)
}

/**
 * The proof dirs of this account in `base` that a dead prover left: older than STALE_PROOF_MS,
 * no live daemon pid in them. A live one (an older build's trial, which had no lifetime) stays.
 */
export async function sweepProofDirs(base: string, now = Date.now()): Promise<number> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  let removed = 0
  for (const name of await fs.readdir(base).catch(() => [] as string[])) {
    if (!/^walnut-proof-[A-Za-z0-9]{6}$/.test(name)) continue
    const dir = path.join(base, name)
    const stat = await fs.lstat(dir).catch(() => null)
    if (!stat || !stat.isDirectory() || stat.uid !== uid || now - stat.mtimeMs < STALE_PROOF_MS) continue
    const pid = Number((await fs.readFile(path.join(dir, 'd', 'daemon.pid'), 'utf8').catch(() => '')).trim())
    if (Number.isSafeInteger(pid) && pid > 1) {
      try { process.kill(pid, 0); continue } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') continue }
    }
    await fs.rm(dir, { recursive: true, force: true }).then(() => { removed++ }, () => {})
  }
  return removed
}

/** The last thing it printed, on one line, for the reason. */
async function said(log: string): Promise<string> {
  const text = (await fs.readFile(log, 'utf8').catch(() => '')).trim()
  if (!text) return ''
  const tail = text.split('\n').slice(-3).join(' ').replace(/\s+/g, ' ')
  return `: ${tail.length > 300 ? `...${tail.slice(-300)}` : tail}`
}
