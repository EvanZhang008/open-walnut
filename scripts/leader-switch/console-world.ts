/**
 * The world of the console rehearsal (scripts/leader-switch/console-rehearsal.ts): the switch
 * rehearsal's two machines (world.ts), where machine A also runs a host daemon of its own, the
 * one the new leader B reaches A by after the switch (as a host, through the direct test
 * transport of tests/helpers/replica-cluster.ts, never ssh). B is a real, non-ephemeral server
 * (console-server.ts) so it can run A's host replica; A stays the rehearsal's ephemeral server.
 * A's home is judged by src/core/home-manifest/home-kept.ts, the check the switch uses.
 *
 * `asInstalled`: A's data home is <A>/.open-walnut (an ephemeral server refuses that path, so A
 * is a real server too) and A's host daemon runs in <A>/.cache/open-walnut, an installed daemon's
 * own default dir, with no stream or journal dir of its own: it keeps its state where an installed
 * one does, inside the data home (tmp/host-server, tmp/streams, local/spawn-journal.jsonl, ...).
 * Otherwise A's host daemon keeps everything in <A>/host-daemon. Either way it is a dedicated
 * daemon beside A's server's own (a server refuses a daemon in an installed dir under a test's
 * HOME, daemon-ownership.ts), where on a real machine one daemon is both.
 *
 * Nothing here reads or writes outside `root`: no ~/.open-walnut, no :3456.
 */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { makeWorld, REPO, switchConfig, type Machine, type World } from './world.js'
import { HOST_RUNTIME, startHostDaemon, windowEnv, writeAppDir, writeStubBin, builtAppMissing } from '../../tests/helpers/replica-cluster.js'
import type { ChildProcess } from 'node:child_process'

export const HOST_KEY_A = 'machine-a'

export interface ConsoleWorld extends World {
  bin: string
  app: string
  asInstalled: boolean
  /** A's host daemon (a source twin of its own). */
  hostDaemon: { proc: ChildProcess; dir: string; pid(): number | null }
  /** B's server (the process LocalSide started), or null. */
  leaderPid(): number | null
  /** A's console replica's pid (the host daemon's child, from its pid file), or null. */
  replicaPid(): number | null
  /** The console files of machine A (beside its machine id, outside every data home). */
  consoleDir: string
  stop(): Promise<void>
}

/** B's server: non-ephemeral, its host A reached by the direct test transport. */
function leaderEnv(w: World, bin: string, app: string, daemonPort: number, asInstalled: boolean): Record<string, string> {
  return {
    ...w.b.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    WALNUT_CONSOLE_HOST_KEY: HOST_KEY_A,
    WALNUT_CONSOLE_HOST_DAEMON_PORT: String(daemonPort),
    WALNUT_CONSOLE_HOST_HOME: w.a.dir,
    WALNUT_HOST_SERVER_APP_DIR: app,
    // The replica's own install root: where an installed host has it (<HOME>/.open-walnut-host)
    // when asInstalled, else a folder of A's own. Named either way: the default root runs the
    // installer over the host link, which the test transport does not carry.
    WALNUT_HOST_SERVER_ROOT: asInstalled ? path.join(w.a.dir, '.open-walnut-host') : path.join(w.a.dir, 'host-root'),
    WALNUT_WEB_STATIC_DIR: path.join(REPO, 'dist', 'web', 'static'),
    WALNUT_LOCAL_CLAUDE_PROBE: '0',
    ...windowEnv(),
  }
}

export async function makeConsoleWorld(root: string, opts: { portA: number; portB: number; asInstalled?: boolean }): Promise<ConsoleWorld> {
  const missing = builtAppMissing()
  if (missing) throw new Error(`the console rehearsal runs the built app (bun run build first): ${missing}`)
  const asInstalled = opts.asInstalled ?? false
  const w = makeWorld(root, { portA: opts.portA, portB: opts.portB, ...(asInstalled ? { homeA: '.open-walnut' } : {}) })
  const bin = path.join(root, 'bin')
  writeStubBin(bin)
  const app = path.join(root, 'app')
  writeAppDir(app, 'built')
  const daemonDir = asInstalled ? path.join(w.a.dir, '.cache', 'open-walnut') : path.join(w.a.dir, 'host-daemon')
  const d = await startHostDaemon('source', daemonDir, w.a.dir, bin, false, { asInstalled })
  const realServer = (m: Machine) => [process.execPath, path.join(REPO, 'scripts/leader-switch/console-server.ts'), '--port', String(m.port)]
  if (asInstalled) {
    w.a.start = realServer(w.a)
    // As installed, A's home is <HOME>/.open-walnut, which a process that inherits a test run's
    // markers (VITEST, NODE_ENV=test) takes for the production home and moves to a temp dir
    // (constants.ts). HOME is this rehearsal's folder, so A runs as an install does, without them;
    // console-server.ts refuses the account's real home.
    w.a.env = { ...w.a.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, WALNUT_LOCAL_CLAUDE_PROBE: '0', ...windowEnv(), VITEST: '', VITEST_WORKER_ID: '', VITEST_POOL_ID: '', NODE_ENV: '' }
  }
  w.b.start = realServer(w.b)
  w.b.env = leaderEnv(w, bin, app, d.port, asInstalled)
  // A's config names B as it now starts.
  fs.writeFileSync(path.join(w.a.home, 'config.yaml'), YAML.stringify(switchConfig(w, w.b.standbyDir)))
  const consoleDir = path.join(w.a.dir, '.local', 'state', 'open-walnut', 'console')
  const pidIn = (dir: string, re: RegExp): number | null => {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!re.test(f)) continue
        const text = fs.readFileSync(path.join(dir, f), 'utf8').trim()
        const pid = /^\d+$/.test(text) ? Number(text) : (JSON.parse(text) as { pid?: number }).pid
        if (typeof pid === 'number') { try { process.kill(pid, 0); return pid } catch { /* gone */ } }
      }
    } catch { /* none */ }
    return null
  }
  const sides = new Map<Machine, ReturnType<World['side']>>()
  const side = (m: Machine) => { let s = sides.get(m); if (!s) { s = w.side(m); sides.set(m, s) } return s }
  return {
    ...w,
    side,
    bin, app, asInstalled,
    hostDaemon: { proc: d.proc, dir: daemonDir, pid: () => d.proc.pid ?? null },
    consoleDir,
    leaderPid: () => side(w.b).runningServer()?.pid ?? null,
    replicaPid: () => pidIn(consoleDir, /\.holder\.json$/),
    async stop() {
      await side(w.a).stopServer().catch(() => {})
      await side(w.b).stopServer().catch(() => {})
      // The host daemon of this world only (its own process, or the pid its own dir names).
      const pid = d.proc.pid
      if (pid) {
        try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
        const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
        for (let i = 0; i < 100 && alive(); i++) await new Promise((r) => setTimeout(r, 100))
      }
    },
  }
}

export { HOST_RUNTIME }
