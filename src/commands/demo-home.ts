import fs from 'node:fs/promises'
import path from 'node:path'
import { accountInfo } from '../lib/account.js'
import { demoTerminalDir, ensureDemoTerminalDir, removeDemoTerminalDir } from '../lib/demo-terminal-dir.js'
import { closeDemoSignIns, prepareDemoSignIns } from './demo-sign-ins.js'
import { assertNoDemoResidualProcesses, assertResidualReportClean, sweepDemoResidualProcesses, type ResidualReport } from './demo-residual-processes.js'
import { demoSearchPath, prepareDemoSsh } from './demo-ssh.js'
import { FIRST_RUN_STEPS } from '../core/first-run.js'

export const DEMO_PORT = 3458
export const DEMO_URL = `http://127.0.0.1:${DEMO_PORT}`

export interface DemoPaths {
  root: string
  home: string
  data: string
  daemon: string
  runtime: string
  /** The generation's dtach sockets: a short private dir in /tmp, not under the root (src/lib/demo-terminal-dir.ts). */
  terminals: string
  state: string
}

export function demoPaths(root = path.join(accountInfo().homedir, '.local', 'share', 'open-walnut-demo'), generation = 'first'): DemoPaths {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(generation)) throw new Error('Invalid Demo generation')
  root = path.resolve(root)
  const home = path.join(root, 'homes', generation)
  return {
    root, home, data: path.join(root, 'data', generation),
    daemon: path.join(root, 'd', generation), runtime: path.join(root, 'runtime'),
    terminals: demoTerminalDir(root, generation),
    state: path.join(root, 'state.json'),
  }
}

export async function assertDemoPaths(paths: DemoPaths): Promise<void> {
  const expected = demoPaths(paths.root, path.basename(paths.home))
  for (const key of Object.keys(expected) as Array<keyof DemoPaths>) {
    if (paths[key] !== expected[key]) throw new Error('Demo paths do not match their isolated root')
  }
  const realHome = path.resolve(accountInfo().homedir)
  const protectedDirs = ['.open-walnut', '.claude'].map(name => path.join(realHome, name))
  if (paths.root === realHome || protectedDirs.some(dir => paths.root === dir || paths.root.startsWith(dir + path.sep))
    || !paths.root.endsWith(`${path.sep}open-walnut-demo`)) {
    throw new Error('Demo requires its own open-walnut-demo directory')
  }
  for (const dir of [paths.root, paths.home, paths.data, paths.daemon, `${paths.daemon}-streams`, paths.runtime, path.join(paths.root, 'task-dirs', path.basename(paths.home))]) {
    let current = dir
    for (;;) {
      try {
        const stat = await fs.lstat(current)
        if (stat.isSymbolicLink() || !stat.isDirectory()
          || (current === paths.root || current.startsWith(paths.root + path.sep)) && process.getuid && stat.uid !== process.getuid()) {
          throw new Error(`Demo directory is not a plain directory owned by this account: ${current}`)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  for (const file of [paths.state, path.join(paths.root, 'server.log'), path.join(paths.data, 'config.yaml')]) {
    try {
      const stat = await fs.lstat(file)
      if (stat.isSymbolicLink() || !stat.isFile() || process.getuid && stat.uid !== process.getuid()) {
        throw new Error(`Demo file is not owned by this account: ${file}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

/** The runtime dir a compiled `walnut demo` unpacks into, checked before anything is written; none for other commands. */
export async function demoRuntimeForArgv(argv: readonly string[]): Promise<string | undefined> {
  if (argv[2] !== 'demo' || argv.includes('--_child')) return undefined
  const at = argv.indexOf('--_root')
  const paths = demoPaths(at >= 0 ? argv[at + 1] : undefined)
  await assertDemoPaths(paths)
  return paths.runtime
}

export function demoChildEnv(parent: NodeJS.ProcessEnv, paths: DemoPaths, token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SYSTEMROOT', 'WINDIR']) {
    if (parent[key] !== undefined) env[key] = parent[key]
  }
  return {
    ...env,
    PATH: demoSearchPath(paths, env.PATH),
    HOME: paths.home, USERPROFILE: paths.home, USER: accountInfo().username,
    XDG_CONFIG_HOME: path.join(paths.home, '.config'),
    XDG_CACHE_HOME: path.join(paths.home, '.cache'),
    XDG_DATA_HOME: path.join(paths.home, '.local', 'share'),
    XDG_STATE_HOME: path.join(paths.home, '.local', 'state'),
    CLAUDE_CONFIG_DIR: path.join(paths.home, '.claude'),
    OPEN_WALNUT_HOME: paths.data,
    WALNUT_DAEMON_DIR: paths.daemon,
    WALNUT_STREAMS_DIR: `${paths.daemon}-streams`,
    WALNUT_AGENT_SOCKET: path.join(paths.terminals, 'agent-gateway.sock'),
    WALNUT_RUNTIME_DIR: paths.runtime,
    WALNUT_TASK_DIR_ROOT: path.join(paths.root, 'task-dirs', path.basename(paths.home)),
    WALNUT_DEMO_TOKEN: token,
    WALNUT_DEMO_ROOT: paths.root,
    WALNUT_DEMO_GENERATION: path.basename(paths.home),
    WALNUT_STT_AUTO_SETUP: '0', WALNUT_SEARCH_V2_SEMANTIC: '0',
    WALNUT_SESSION_HOST: '0',
    OPEN_WALNUT_API_URL: DEMO_URL, WALNUT_SERVER_URL: DEMO_URL,
  }
}

export async function prepareDemoHome(paths: DemoPaths): Promise<void> {
  await assertDemoPaths(paths)
  for (const dir of [paths.root, paths.home, paths.data, paths.daemon, `${paths.daemon}-streams`, paths.runtime]) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  }
  ensureDemoTerminalDir(paths.terminals, paths.data)
  await prepareDemoSignIns(paths)
  await prepareDemoSsh(paths)
  const config = path.join(paths.data, 'config.yaml')
  try {
    // The Demo is a new user's first run, so it asks the first-run questions too (the host
    // step: 2026-11-12, the user saw no remote host in a new Demo). The pre-written file would
    // otherwise keep the server's own stamp (stampFirstRun) from ever writing them.
    await fs.writeFile(config, demoConfigYaml(), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/** Generations an earlier reset kept: plain dirs in homes/ with a generation name, never `skip`; none when homes/ cannot be read. */
export async function keptDemoGenerations(root: string, skip: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, 'homes'), { withFileTypes: true }).catch(() => [])
  return entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^[a-zA-Z0-9-]{1,64}$/.test(entry.name) && entry.name !== skip)
    .map(entry => entry.name).sort()
}

/** Why a reset kept a generation: no look exists on this system, the look could not be read in time, or a process it read could not be judged. */
export type DemoKept = 'unsupported' | 'unread' | 'unknown'

/** The one reason a look that matched nothing still keeps the data; none when it is clean. */
export function demoKeptBy(report: ResidualReport): DemoKept | undefined {
  if (report.matched) return undefined
  if (!report.supported) return 'unsupported'
  if (!report.complete) return 'unread'
  return report.unknown ? 'unknown' : undefined
}

/** `true` once cleared; with `keepUnconfirmed`, why the generation was kept instead of a throw. */
export async function clearDemoHome(paths: DemoPaths, keepUnconfirmed = false): Promise<true | DemoKept> {
  await assertDemoPaths(paths)
  await closeDemoSignIns(paths)
  // Unknown OS processes keep the old generation intact; a reset can start a separate one without deleting their files.
  if (keepUnconfirmed) {
    const report = await sweepDemoResidualProcesses(paths)
    const kept = demoKeptBy(report)
    if (kept) return kept
    // Act on this one look. A second look found a short-lived program of the account it could
    // not judge on a busy Mac, and the reset stopped with "run it again" (2026-11-09 review).
    assertResidualReportClean(report)
  } else await assertNoDemoResidualProcesses(paths)
  // First, while the data dir its marker names still exists: a dir that is not this Demo's throws and nothing is cleared.
  await removeDemoTerminalDir(paths.terminals, paths.data)
  for (const dir of [paths.home, paths.data, paths.daemon, `${paths.daemon}-streams`, path.join(paths.root, 'task-dirs', path.basename(paths.home))]) {
    await fs.rm(dir, { recursive: true, force: true })
  }
  return true
}

/** A new generation's config.yaml: no self-update, and the first-run questions still to ask. */
export function demoConfigYaml(now: Date = new Date()): string {
  const steps = FIRST_RUN_STEPS.map((step) => `    - ${step}\n`).join('')
  return `updates:\n  auto: false\nfirst_run:\n  at: ${now.toISOString()}\n  steps:\n${steps}`
}
