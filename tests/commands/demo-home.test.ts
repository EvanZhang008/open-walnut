/**
 * `walnut demo` runs a first-run Walnut in its own HOME (src/commands/demo-home.ts).
 * These tests pin the isolation it promises: the child env carries none of the
 * caller's credentials, sessions or API identity and points every store into the
 * Demo generation; prepare only creates its own empty config; clear removes only
 * the generation's own dirs; and the path guard refuses anything that is not a
 * plain directory tree under an `open-walnut-demo` root that is not the account home.
 *
 * The OS account is mocked to a neutral temp dir, so nothing here reads the real
 * HOME or starts any process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const account = vi.hoisted(() => ({ homedir: '' }))
vi.mock('../../src/lib/account.js', () => ({
  accountInfo: () => ({ username: 'demo-user', homedir: account.homedir, shell: '/bin/sh', uid: 501, gid: 20 }),
}))
// The process sweep reads the real process table; it has its own tests in demo-residual-processes.test.ts.
const sweep = vi.hoisted(() => ({ assert: vi.fn(async (_paths: unknown) => {}), report: vi.fn(async (_paths: unknown) => ({}) as unknown) }))
vi.mock('../../src/commands/demo-residual-processes.js', async (orig) => ({
  assertNoDemoResidualProcesses: sweep.assert, sweepDemoResidualProcesses: sweep.report,
  // The verdict on a look already taken is the real one: it reads only the report it is given.
  assertResidualReportClean: (await orig<typeof import('../../src/commands/demo-residual-processes.js')>()).assertResidualReportClean,
}))
const why = { envHidden: 0, cwdUnreadable: 0, unreadable: 0, raced: 0 }
const report = (r: Partial<{ supported: boolean; complete: boolean; matched: number; unknown: number }> = {}) => ({ supported: true, complete: true, matched: 0, unknown: 0, why, ...r })

import {
  assertDemoPaths, clearDemoHome, demoChildEnv, demoPaths as getDemoPaths, demoRuntimeForArgv, keptDemoGenerations, prepareDemoHome, DEMO_URL, type DemoPaths,
} from '../../src/commands/demo-home.js'
import { DEMO_PROFILES, demoSshBinDir, demoSshConfigFile } from '../../src/commands/demo-ssh.js'

let base: string
let root: string
const terminalDirs = new Set<string>()
function demoPaths(...args: Parameters<typeof getDemoPaths>): DemoPaths {
  const paths = getDemoPaths(...args)
  terminalDirs.add(paths.terminals)
  return paths
}

beforeEach(() => {
  sweep.assert.mockReset().mockResolvedValue(undefined)
  sweep.report.mockReset().mockResolvedValue(report())
  // realpath: on macOS the temp dir sits behind the /var symlink, which the guard refuses.
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-demo-home-')))
  account.homedir = path.join(base, 'account')
  fs.mkdirSync(account.homedir)
  root = path.join(base, 'parent', 'open-walnut-demo')
})

afterEach(() => {
  for (const dir of terminalDirs) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  }
  terminalDirs.clear()
  fs.rmSync(base, { recursive: true, force: true })
})

function write(file: string, text = 'keep'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const TOKEN = '11111111-2222-3333-4444-555555555555'

describe('demoPaths', () => {
  it('defaults under the (mocked) account home, never the environment HOME', () => {
    expect(demoPaths().root).toBe(path.join(account.homedir, '.local', 'share', 'open-walnut-demo'))
  })

  it('refuses a generation that could leave homes/', () => {
    for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', 'x\u0000', 'a b', 'a'.repeat(65), '/abs']) {
      expect(() => demoPaths(root, bad), JSON.stringify(bad)).toThrow(/Invalid Demo generation/)
    }
  })
})

describe('demoChildEnv', () => {
  const SENSITIVE: Record<string, string> = {
    AWS_ACCESS_KEY_ID: 'example-access-id', AWS_SECRET_ACCESS_KEY: 'secret', AWS_SESSION_TOKEN: 'session',
    AWS_PROFILE: 'work', AWS_BEARER_TOKEN_BEDROCK: 'bearer', AWS_CONFIG_FILE: '/x/config',
    AWS_SHARED_CREDENTIALS_FILE: '/x/credentials',
    ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_AUTH_TOKEN: 'auth', ANTHROPIC_BASE_URL: 'http://proxy',
    OPENAI_API_KEY: 'sk-openai', GITHUB_TOKEN: 'gh', GH_TOKEN: 'gh',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth', CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
    CLAUDE_CONFIG_DIR: '/real/.claude',
    XDG_CONFIG_HOME: '/real/.config', XDG_DATA_HOME: '/real/.local/share',
    OPEN_WALNUT_HOME: '/real/.open-walnut', WALNUT_DAEMON_DIR: '/tmp/open-walnut',
    WALNUT_SESSION_ID: 'real-session', WALNUT_TASK_ID: 'real-task', WALNUT_TASK_DIR: '/real/task',
    WALNUT_TEST_RUN: 'label', WALNUT_CALLER_SID: 'caller', CLAUDECODE: '1',
    OPEN_WALNUT_API_URL: 'http://127.0.0.1:3456', WALNUT_SERVER_URL: 'http://127.0.0.1:3456',
    SSH_AUTH_SOCK: '/real/agent.sock',
  }
  const parent = (): NodeJS.ProcessEnv => ({
    ...SENSITIVE, HOME: account.homedir, USERPROFILE: account.homedir,
    PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TZ: 'UTC',
  })

  it('points the agent socket into its own short terminal dir, never the caller socket', () => {
    const paths = demoPaths(root, randomUUID())
    const callerSocket = path.join(account.homedir, '.open-walnut', 'agent-gateway.sock')
    const env = demoChildEnv({ ...parent(), WALNUT_AGENT_SOCKET: callerSocket }, paths, TOKEN)
    // Outside the root on purpose: a per-generation daemon path is too long for a macOS socket (104 bytes).
    expect(env.WALNUT_AGENT_SOCKET).toBe(path.join(paths.terminals, 'agent-gateway.sock'))
    expect(env.WALNUT_AGENT_SOCKET).not.toBe(callerSocket)
    expect(env.WALNUT_AGENT_SOCKET!.startsWith(root + path.sep)).toBe(false)
    const other = demoPaths(root, randomUUID())
    expect(demoChildEnv(parent(), other, TOKEN).WALNUT_AGENT_SOCKET).not.toBe(env.WALNUT_AGENT_SOCKET)
  })

  it('drops credentials, sessions and the real API identity from the caller', () => {
    const paths = demoPaths(root, randomUUID())
    const env = demoChildEnv(parent(), paths, TOKEN)
    for (const [key, value] of Object.entries(SENSITIVE)) {
      expect(env[key], key).not.toBe(value)
    }
    for (const key of Object.keys(env)) {
      expect(key, key).not.toMatch(/^(AWS_|ANTHROPIC_|OPENAI_|GITHUB_|GH_|CLAUDE_CODE_|SSH_)|OAUTH|SECURESTORAGE|API_KEY|SESSION_ID|CALLER|TEST_RUN/)
    }
    expect(env.OPEN_WALNUT_API_URL).toBe(DEMO_URL)
    expect(env.WALNUT_SERVER_URL).toBe(DEMO_URL)
    expect(env.WALNUT_DEMO_TOKEN).toBe(TOKEN)
    // Plain locale/shell keys still pass through, behind the Demo's own ssh and scp (demo-ssh.test.ts).
    expect(env.PATH).toBe(process.platform === 'win32' ? '/usr/bin:/bin' : `${demoSshBinDir(paths)}:/usr/bin:/bin`)
    expect(env.LANG).toBe('en_US.UTF-8')
    expect(env.TZ).toBe('UTC')
  })

  it('sets HOME to the generation home: non-empty, absolute, not the account home', () => {
    const paths = demoPaths(root, randomUUID())
    const env = demoChildEnv(parent(), paths, TOKEN)
    expect(env.HOME).toBe(paths.home)
    expect(env.HOME).toBeTruthy()
    expect(path.isAbsolute(env.HOME!)).toBe(true)
    expect(env.HOME).not.toBe(account.homedir)
    expect(env.USERPROFILE).toBe(paths.home)
    expect(env.OPEN_WALNUT_HOME).toBe(paths.data)
    expect(env.WALNUT_DAEMON_DIR).toBe(paths.daemon)
    // Daemon and task dirs are per generation, so a fresh reset never shares them with a kept one.
    expect(paths.daemon).toBe(path.join(root, 'd', path.basename(paths.home)))
    expect(env.WALNUT_TASK_DIR_ROOT).toBe(path.join(root, 'task-dirs', path.basename(paths.home)))
    for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
      'CLAUDE_CONFIG_DIR', 'OPEN_WALNUT_HOME', 'WALNUT_DAEMON_DIR', 'WALNUT_STREAMS_DIR', 'WALNUT_RUNTIME_DIR',
      'WALNUT_TASK_DIR_ROOT']) {
      const value = env[key]
      expect(value, key).toBeTruthy()
      expect(path.isAbsolute(value!), key).toBe(true)
      expect(value!.startsWith(root + path.sep), key).toBe(true)
    }
  })

  it('gives each generation its own HOME and credential store', () => {
    const a = demoChildEnv(parent(), demoPaths(root, randomUUID()), TOKEN)
    const b = demoChildEnv(parent(), demoPaths(root, randomUUID()), TOKEN)
    expect(a.WALNUT_DEMO_GENERATION).not.toBe(b.WALNUT_DEMO_GENERATION)
    for (const key of ['HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'OPEN_WALNUT_HOME']) {
      expect(a[key], key).not.toBe(b[key])
    }
    expect(a.CLAUDE_CONFIG_DIR!.startsWith(a.HOME! + path.sep)).toBe(true)
    expect(b.CLAUDE_CONFIG_DIR!.startsWith(b.HOME! + path.sep)).toBe(true)
  })
})

describe('prepareDemoHome', () => {
  it('creates only its own dirs and an empty-ish config with updates off', async () => {
    const paths = demoPaths(root, randomUUID())
    await prepareDemoHome(paths)
    for (const dir of [paths.root, paths.home, paths.data, paths.daemon, `${paths.daemon}-streams`, paths.runtime]) {
      expect(fs.statSync(dir).isDirectory(), dir).toBe(true)
      expect(fs.statSync(dir).mode & 0o077, dir).toBe(0)
    }
    const config = path.join(paths.data, 'config.yaml')
    expect(fs.readFileSync(config, 'utf8')).toMatch(/^updates:\n  auto: false\nfirst_run:\n  at: \S+\n  steps:\n    - hosts\n$/)
    expect(fs.statSync(config).mode & 0o777).toBe(0o600)
    // Besides the config, only the Demo's own SSH settings, wrappers and profiles (demo-ssh.test.ts).
    const sshDir = path.dirname(demoSshConfigFile(paths))
    const profiles = DEMO_PROFILES.map(name => path.join(paths.home, name))
    const files = (fs.readdirSync(root, { recursive: true }) as string[])
      .filter(rel => fs.statSync(path.join(root, rel)).isFile())
      .filter(rel => !path.join(root, rel).startsWith(sshDir + path.sep) && !profiles.includes(path.join(root, rel)))
    expect(files).toEqual([path.relative(root, config)])
    if (process.platform !== 'win32') expect(fs.existsSync(demoSshConfigFile(paths))).toBe(true)
    expect(fs.readdirSync(account.homedir)).toEqual([])
    // The terminal sockets get their own short private dir, claimed for this generation's data.
    expect(paths.terminals.startsWith(root + path.sep)).toBe(false)
    expect(fs.lstatSync(paths.terminals).isDirectory()).toBe(true)
    expect(fs.lstatSync(paths.terminals).mode & 0o077).toBe(0)
    expect(fs.readdirSync(paths.terminals)).toEqual(['.owner'])
    expect(fs.readFileSync(path.join(paths.terminals, '.owner'), 'utf8')).toBe(`${paths.data}\n`)
  })

  it('opens the same terminal dir again for the same generation, a new one for another', async () => {
    const gen = randomUUID()
    const paths = demoPaths(root, gen)
    await prepareDemoHome(paths)
    await prepareDemoHome(demoPaths(root, gen))
    expect(demoPaths(root, gen).terminals).toBe(paths.terminals)
    expect(demoPaths(root, randomUUID()).terminals).not.toBe(paths.terminals)
  })

  it('refuses a terminal dir another Demo claimed', async () => {
    const paths = demoPaths(root, randomUUID())
    fs.mkdirSync(paths.terminals, { mode: 0o700 })
    const foreign = path.join(base, 'other-demo-data')
    fs.writeFileSync(path.join(paths.terminals, '.owner'), `${foreign}\n`)
    await expect(prepareDemoHome(paths)).rejects.toThrow(/another Walnut/)
    expect(fs.readFileSync(path.join(paths.terminals, '.owner'), 'utf8')).toBe(`${foreign}\n`)
  })

  it('never overwrites an existing config', async () => {
    const paths = demoPaths(root, randomUUID())
    write(path.join(paths.data, 'config.yaml'), 'custom: true\n')
    await prepareDemoHome(paths)
    expect(fs.readFileSync(path.join(paths.data, 'config.yaml'), 'utf8')).toBe('custom: true\n')
  })
})

describe('clearDemoHome', () => {
  /** One generation with a file in each dir clear owns, and the files every clear must keep. */
  async function plant(): Promise<{ paths: DemoPaths; owned: string[]; kept: string[]; otherPaths: DemoPaths }> {
    const gen = randomUUID()
    const other = randomUUID()
    const paths = demoPaths(root, gen)
    await prepareDemoHome(paths)
    const owned = [
      path.join(paths.home, '.claude', 'credentials.json'),
      path.join(paths.data, 'tasks.json'),
      path.join(paths.daemon, 'daemon.port'),
      path.join(`${paths.daemon}-streams`, 's.jsonl'),
      path.join(root, 'task-dirs', gen, 't1', 'f'),
      path.join(paths.terminals, 'walnut-y.dpid'),
    ]
    for (const file of owned) write(file)
    const otherPaths = demoPaths(root, other)
    await prepareDemoHome(otherPaths)
    const kept = [
      path.join(otherPaths.data, 'tasks.json'),
      path.join(otherPaths.daemon, 'daemon.port'),
      path.join(`${otherPaths.daemon}-streams`, 's.jsonl'),
      path.join(root, 'task-dirs', other, 't2', 'f'),
      path.join(otherPaths.terminals, 'walnut-x.dsock'),
      path.join(paths.runtime, 'build', 'file'),
      path.join(root, 'installation', 'bin', 'walnut'),
      path.join(root, 'server.log'),
      paths.state,
      path.join(base, 'parent', 'other-data', 'file'),
      path.join(account.homedir, '.open-walnut', 'tasks.json'),
    ]
    for (const file of kept) write(file)
    return { paths, owned, kept, otherPaths }
  }
  const expectKept = (files: string[]) => { for (const file of files) expect(fs.readFileSync(file, 'utf8'), file).toBe('keep') }

  it('removes the generation home, data, daemon, streams, task dir and terminals, and no other generation', async () => {
    const { paths, kept } = await plant()
    await expect(clearDemoHome(paths)).resolves.toBe(true)
    for (const gone of [paths.home, paths.data, paths.daemon, `${paths.daemon}-streams`, path.join(root, 'task-dirs', path.basename(paths.home)), paths.terminals]) {
      expect(fs.existsSync(gone), gone).toBe(false)
    }
    expectKept(kept)
    expect(fs.statSync(path.join(root, 'd')).isDirectory()).toBe(true)
    expect(fs.statSync(path.join(root, 'task-dirs')).isDirectory()).toBe(true)
    expect(sweep.assert).toHaveBeenCalledWith(paths)
  })

  it('a reset acts on its one look: a second look that would find a short-lived program does not stop it', async () => {
    // 2026-11-09, a busy Mac: the reset's first look was clean, a second look saw a short-lived
    // program it could not judge, and the reset stopped with "run walnut demo reset again".
    const { paths, kept } = await plant()
    sweep.assert.mockRejectedValue(new Error('2 processes of this account could not be checked for Demo use.'))
    await expect(clearDemoHome(paths, true)).resolves.toBe(true)
    expect(sweep.report).toHaveBeenCalledTimes(1)
    expect(sweep.assert).not.toHaveBeenCalled()
    expect(fs.existsSync(paths.home)).toBe(false)
    expectKept(kept)
  })

  it('a reset with every process confirmed gone clears and returns true', async () => {
    const { paths, kept } = await plant()
    await expect(clearDemoHome(paths, true)).resolves.toBe(true)
    expect(fs.existsSync(paths.home)).toBe(false)
    expect(fs.existsSync(paths.daemon)).toBe(false)
    expectKept(kept)
  })

  it.each([
    ['unknown processes', report({ unknown: 3 }), 'unknown'],
    ['an incomplete process table', report({ complete: false }), 'unread'],
    ['an unsupported system', report({ supported: false, complete: false }), 'unsupported'],
  ])('a reset facing %s keeps every old dir and says why', async (_name, answer, why) => {
    const { paths, owned, kept } = await plant()
    sweep.report.mockResolvedValue(answer)
    sweep.assert.mockRejectedValue(new Error('could not be checked'))
    await expect(clearDemoHome(paths, true)).resolves.toBe(why)
    expectKept([...owned, ...kept])
  })

  it.each([
    ['unknown processes', report({ unknown: 3 })],
    ['an incomplete process table', report({ complete: false })],
  ])('a strict clear facing %s refuses and keeps every dir', async (_name, answer) => {
    const { paths, owned, kept } = await plant()
    sweep.report.mockResolvedValue(answer)
    sweep.assert.mockRejectedValue(new Error('could not be checked. Demo data was kept.'))
    await expect(clearDemoHome(paths)).rejects.toThrow(/could not be checked/)
    expectKept([...owned, ...kept])
  })

  it.each([false, true])('a matched Demo process refuses (keepUnconfirmed %s) and keeps every dir', async keep => {
    const { paths, owned, kept } = await plant()
    sweep.report.mockResolvedValue(report({ matched: 1, unknown: 2 }))
    sweep.assert.mockRejectedValue(new Error('1 process started in the Demo is still running. Demo data was kept.'))
    await expect(clearDemoHome(paths, keep)).rejects.toThrow()
    expectKept([...owned, ...kept])
  })

  it('clears nothing when the terminal dir is claimed by another Demo', async () => {
    const paths = demoPaths(root, randomUUID())
    await prepareDemoHome(paths)
    write(path.join(paths.home, 'keep.txt'))
    fs.writeFileSync(path.join(paths.terminals, '.owner'), `${path.join(base, 'other-demo-data')}\n`)
    await expect(clearDemoHome(paths)).rejects.toThrow(/another Walnut/)
    expect(fs.readFileSync(path.join(paths.home, 'keep.txt'), 'utf8')).toBe('keep')
    expect(fs.existsSync(paths.terminals)).toBe(true)
  })

  it('succeeds when nothing is there yet', async () => {
    await expect(clearDemoHome(demoPaths(root, randomUUID()))).resolves.toBe(true)
  })
})

describe('keptDemoGenerations', () => {
  it('lists plain generation dirs in homes/, skipping the one named, symlinks, files and other names', async () => {
    expect(await keptDemoGenerations(root, 'none')).toEqual([])
    const homes = path.join(root, 'homes')
    for (const name of ['gen-b', 'gen-a', 'current', 'bad_name', 'x'.repeat(65)]) fs.mkdirSync(path.join(homes, name), { recursive: true })
    fs.mkdirSync(path.join(base, 'elsewhere'))
    fs.symlinkSync(path.join(base, 'elsewhere'), path.join(homes, 'linked'))
    fs.writeFileSync(path.join(homes, 'file-1'), 'keep')
    expect(await keptDemoGenerations(root, 'current')).toEqual(['gen-a', 'gen-b'])
    expect(fs.readdirSync(homes).sort()).toEqual(['bad_name', 'current', 'file-1', 'gen-a', 'gen-b', 'linked', 'x'.repeat(65)].sort())
  })
})

describe('assertDemoPaths refusals', () => {
  async function refuses(paths: DemoPaths, victim?: string): Promise<void> {
    await expect(assertDemoPaths(paths)).rejects.toThrow()
    await expect(prepareDemoHome(paths)).rejects.toThrow()
    await expect(clearDemoHome(paths)).rejects.toThrow()
    if (victim) expect(fs.readFileSync(victim, 'utf8')).toBe('keep')
  }

  it('accepts its own plain tree', async () => {
    await expect(assertDemoPaths(demoPaths(root, randomUUID()))).resolves.toBeUndefined()
  })

  it('refuses the account HOME as root', async () => {
    account.homedir = root
    fs.mkdirSync(root, { recursive: true })
    const victim = path.join(root, 'homes', 'g', 'keep.txt')
    write(victim)
    await refuses(demoPaths(root, 'g'), victim)
  })

  it('refuses a root whose basename is not open-walnut-demo', async () => {
    for (const name of ['walnut-demo', 'open-walnut-demo-x', 'xopen-walnut-demo', '.open-walnut']) {
      const wrong = path.join(base, 'parent', name)
      const victim = path.join(wrong, 'homes', 'g', 'keep.txt')
      write(victim)
      await refuses(demoPaths(wrong, 'g'), victim)
    }
  })

  it('refuses a root that is the filesystem root or a file', async () => {
    await expect(assertDemoPaths(demoPaths('/', 'g'))).rejects.toThrow()
    write(root)
    await refuses(demoPaths(root, 'g'))
  })

  it('refuses paths that do not match their root, or a malicious generation', async () => {
    const victim = path.join(base, 'victim', 'keep.txt')
    write(victim)
    const good = demoPaths(root, 'g')
    for (const key of ['home', 'data', 'daemon', 'runtime', 'terminals', 'state'] as const) {
      await refuses({ ...good, [key]: path.dirname(victim) }, victim)
    }
    await refuses({ ...good, home: `${root}${path.sep}homes${path.sep}..` }, victim)
    await refuses({ ...good, home: path.join(base, 'victim'), data: path.join(base, 'victim', '.open-walnut') }, victim)
    await refuses({ ...good, root: path.join(root, '..', 'open-walnut-demo') + path.sep + '.' }, victim)
  })

  it('refuses a symlinked parent of the root', async () => {
    const real = path.join(base, 'real-parent')
    const victim = path.join(real, 'open-walnut-demo', 'homes', 'g', 'keep.txt')
    write(victim)
    fs.symlinkSync(real, path.join(base, 'link-parent'))
    const paths = demoPaths(path.join(base, 'link-parent', 'open-walnut-demo'), 'g')
    await refuses(paths, victim)
    expect(fs.existsSync(path.join(real, 'open-walnut-demo', 'd'))).toBe(false)
  })

  it('refuses a symlinked root', async () => {
    const real = path.join(base, 'real-root')
    const victim = path.join(real, 'homes', 'g', 'keep.txt')
    write(victim)
    fs.mkdirSync(path.dirname(root), { recursive: true })
    fs.symlinkSync(real, root)
    await refuses(demoPaths(root, 'g'), victim)
  })

  it('refuses a symlinked data dir and writes nothing through it', async () => {
    const elsewhere = path.join(base, 'elsewhere')
    const victim = path.join(elsewhere, 'keep.txt')
    write(victim)
    const paths = demoPaths(root, 'g')
    fs.mkdirSync(paths.home, { recursive: true })
    fs.mkdirSync(path.dirname(paths.data), { recursive: true })
    fs.symlinkSync(elsewhere, paths.data)
    await refuses(paths, victim)
    expect(fs.existsSync(path.join(elsewhere, 'config.yaml'))).toBe(false)
    expect(fs.existsSync(paths.home)).toBe(true)
  })

  it.each(['task-dirs', 'task-dirs/g'])('refuses a symlinked %s without deleting its target', async dir => {
    const elsewhere = path.join(base, 'elsewhere-tasks')
    const victim = path.join(elsewhere, 'keep.txt')
    write(victim)
    const link = path.join(root, dir)
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(elsewhere, link)
    await refuses(demoPaths(root, 'g'), victim)
  })

  it('refuses a symlinked daemon dir', async () => {
    const elsewhere = path.join(base, 'elsewhere-daemon')
    const victim = path.join(elsewhere, 'keep.txt')
    write(victim)
    const paths = demoPaths(root, 'g')
    fs.mkdirSync(path.dirname(paths.daemon), { recursive: true })
    fs.symlinkSync(elsewhere, paths.daemon)
    await refuses(paths, victim)
  })
})

describe('demoRuntimeForArgv (the compiled file checks the Demo root before it unpacks)', () => {
  const bin = '/opt/walnut'
  it('names the root\'s runtime dir for walnut demo, none for its child or another command', async () => {
    expect(await demoRuntimeForArgv([bin, 'walnut', 'demo', '--_root', root])).toBe(path.join(root, 'runtime'))
    expect(await demoRuntimeForArgv([bin, 'walnut', 'demo', 'reset', '--_root', root])).toBe(path.join(root, 'runtime'))
    expect(await demoRuntimeForArgv([bin, 'walnut', 'demo', '--_child', '--_ephemeral-child'])).toBeUndefined()
    expect(await demoRuntimeForArgv([bin, 'walnut', 'web'])).toBeUndefined()
  })

  it('refuses a root reached through a link, before anything is written', async () => {
    const real = path.join(base, 'real')
    fs.mkdirSync(path.join(real, 'open-walnut-demo'), { recursive: true })
    fs.symlinkSync(real, path.join(base, 'link'))
    await expect(demoRuntimeForArgv([bin, 'walnut', 'demo', '--_root', path.join(base, 'link', 'open-walnut-demo')]))
      .rejects.toThrow(/not a plain directory/)
    expect(fs.readdirSync(path.join(real, 'open-walnut-demo'))).toEqual([])
  })

  it('answers a refused root with one line and exit 1 in the compiled file, never a stack', () => {
    const text = fs.readFileSync(path.resolve(__dirname, '../../src/binary/runtime-root.ts'), 'utf8')
    const block = /try \{\n\s+const demoRuntime = await demoRuntimeForArgv\(process\.argv\)[\s\S]*?\n\}\n/.exec(text)?.[0] ?? ''
    expect(block).toMatch(/catch \(error\) \{\n\s+process\.stderr\.write\(`\$\{error instanceof Error/)
    expect(block).toMatch(/process\.exit\(1\)/)
    expect(text.match(/demoRuntimeForArgv\(/g)).toHaveLength(1)
  })
})
