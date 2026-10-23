/**
 * The install scripts (src/core/host-server/install.ts), run for real with `sh`
 * in a temp HOME. A host server: a stand-in walnut file (a sh script that answers
 * `--version` the way the compiled file does), gzipped as the Mac uploads it. The
 * real compiled file goes through the same script in host-server-file-e2e.test.ts.
 * The companion's Node install: a fake build tarball, a fake Node and npm.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import zlib from 'node:zlib'
import {
  fileInstallScript, freePortsScript, installScript, launchScript, parseFreePorts, parseInstallState, stateScript,
} from '../../src/core/host-server/install.js'

let home = ''
let bin = ''

function sh(script: string): { out: string; code: number } {
  const r = spawnSync('sh', ['-s'], { input: script, env: { HOME: home, PATH: guardedPath([bin], '/usr/bin:/bin') }, encoding: 'utf8', timeout: 30_000 })
  return { out: `${r.stdout}${r.stderr}`, code: r.status ?? -1 }
}

function makeBuild(id: string, cliBody = 'console.log("0.0.1")'): void {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hsi-build-'))
  fs.mkdirSync(path.join(work, 'package', 'dist'), { recursive: true })
  fs.writeFileSync(path.join(work, 'package', 'dist', 'cli.js'), cliBody)
  fs.mkdirSync(path.join(home, '.open-walnut-host', 'incoming'), { recursive: true })
  execFileSync('tar', ['-czf', path.join(home, '.open-walnut-host', 'incoming', `${id}.tgz`), '-C', work, 'package'])
  fs.rmSync(work, { recursive: true, force: true })
}

function plan(id: string, over: Partial<Parameters<typeof installScript>[0]> = {}) {
  return {
    id, depsHash: 'deps01', dependencies: { ws: '^8.19.0' },
    appPackageJson: JSON.stringify({ name: 'open-walnut', version: '0.0.1', private: true, type: 'module' }),
    node: path.join(bin, 'node'), buildEnv: {}, ...over,
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hsi-home-'))
  bin = path.join(home, 'bin')
  fs.mkdirSync(bin)
  // node runs the real one; npm writes a marker module and the env it saw.
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nmkdir -p node_modules/ws && echo "CC=${CC:-} CXX=${CXX:-}" > node_modules/ws/env.txt && echo "npm $*" > node_modules/ws/args.txt\n', { mode: 0o755 })
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('the companion\'s install script (a Node build and its npm dependencies)', () => {
  it('installs the dependencies once, the build beside them, and marks both ready', () => {
    makeBuild('b1')
    fs.writeFileSync(path.join(home, 'install.sh'), installScript(plan('b1', { buildEnv: { CC: 'cc-x', CXX: 'cxx-x' } })))
    const r = sh(`sh "$HOME/install.sh"`)
    expect(r.out).toContain('installed')
    const root = path.join(home, '.open-walnut-host')
    expect(fs.existsSync(path.join(root, 'app', 'b1', '.ready'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'deps', 'deps01', '.ready'))).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(root, 'deps', 'deps01', 'package.json'), 'utf8')).dependencies).toEqual({ ws: '^8.19.0' })
    expect(fs.readFileSync(path.join(root, 'deps', 'deps01', 'node_modules', 'ws', 'env.txt'), 'utf8').trim()).toBe('CC=cc-x CXX=cxx-x')
    expect(fs.readFileSync(path.join(root, 'deps', 'deps01', 'node_modules', 'ws', 'args.txt'), 'utf8')).toContain('install --no-audit --no-fund --omit=optional --omit=dev')
    // The build links its dependencies and is a module package.
    expect(fs.readlinkSync(path.join(root, 'app', 'b1', 'node_modules'))).toBe('../../deps/deps01/node_modules')
    expect(fs.existsSync(path.join(root, 'app', 'b1', 'node_modules', 'ws', 'env.txt'))).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(root, 'app', 'b1', 'package.json'), 'utf8')).type).toBe('module')
    expect(fs.existsSync(path.join(root, 'incoming', 'b1.tgz'))).toBe(false)
    expect(parseInstallState(sh(stateScript('b1')).out)).toEqual({ state: 'ready' })
  })

  it('a second build reuses the dependencies and keeps only the newest other build', () => {
    for (const id of ['b1', 'b2', 'b3']) {
      makeBuild(id)
      fs.writeFileSync(path.join(home, `${id}.sh`), installScript(plan(id)))
      expect(sh(`sh "$HOME/${id}.sh"`).out).toContain('installed')
      fs.writeFileSync(path.join(home, '.open-walnut-host', 'deps', 'deps01', 'node_modules', 'ws', `${id}.seen`), '')
    }
    const root = path.join(home, '.open-walnut-host')
    expect(fs.readdirSync(path.join(root, 'app')).sort()).toEqual(['b2', 'b3'])
    // One install of the dependencies: the marker from b1 is still there.
    expect(fs.existsSync(path.join(root, 'deps', 'deps01', 'node_modules', 'ws', 'b1.seen'))).toBe(true)
  })

  it('a build that does not start fails, says why, and leaves nothing marked ready', () => {
    makeBuild('bad', 'process.stderr.write("SyntaxError: boom\\n"); process.exit(1)')
    fs.writeFileSync(path.join(home, 'bad.sh'), installScript(plan('bad')))
    expect(sh(`sh "$HOME/bad.sh"`).code).toBe(1)
    const st = parseInstallState(sh(stateScript('bad')).out)
    expect(st.state).toBe('failed')
    expect(st.state === 'failed' && st.message).toMatch(/the build does not start with .*node: SyntaxError: boom/)
    expect(fs.existsSync(path.join(home, '.open-walnut-host', 'app', 'bad'))).toBe(false)
  })

  it('a failing dependency install names the log', () => {
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho "gyp ERR! compiler too old" >&2; exit 1\n', { mode: 0o755 })
    makeBuild('b1')
    fs.writeFileSync(path.join(home, '.open-walnut-host', 'incoming', 'b1.install.sh'), installScript(plan('b1')))
    expect(sh(launchScript('b1')).out).toContain('launched')
    let st = parseInstallState(sh(stateScript('b1')).out)
    for (let i = 0; i < 100 && st.state === 'running'; i++) {
      spawnSync('sleep', ['0.1'])
      st = parseInstallState(sh(stateScript('b1')).out)
    }
    expect(st.state).toBe('failed')
    if (st.state !== 'failed') return
    expect(st.message).toMatch(/npm install of its dependencies failed: see .*b1\.install\.log/)
    expect(st.logTail).toContain('gyp ERR! compiler too old')
  })

  it('refuses a build env name that is not one', () => {
    expect(() => installScript(plan('b1', { buildEnv: { 'CC; rm -rf /': 'x' } }))).toThrow(/not an environment variable name/)
  })

  it('a host plan (no keep, no optional dependencies) is byte for byte the script it was before both existed', () => {
    const hostPlan = {
      id: 'b1', depsHash: 'deps01', dependencies: { ws: '^8.19.0' },
      appPackageJson: JSON.stringify({ name: 'open-walnut', version: '0.0.1', private: true, type: 'module' }),
      node: '/opt/node/bin/node', buildEnv: {}, root: '/srv/walnut-host',
    }
    const text = installScript(hostPlan)
    // sha256 of the text before `keep` and `optionalDependencies` were added (5408d5875).
    expect(crypto.createHash('sha256').update(text).digest('hex')).toBe('b4b9e4632209b5736f518ba10edb22c0d0c89ed66bb092551e24026dfcbc006c')
    expect(installScript({ ...hostPlan, keep: [] })).toBe(text)
    expect(text).toContain('--omit=optional --omit=dev')
    expect(text).not.toContain('optionalDependencies')
  })

  it('with optional dependencies, npm installs them (no --omit=optional) and the deps package names them', () => {
    makeBuild('b1')
    fs.writeFileSync(path.join(home, 'b1.sh'), installScript(plan('b1', { optionalDependencies: { fsevents: '^2.3.3' } })))
    expect(sh(`sh "$HOME/b1.sh"`).out).toContain('installed')
    const deps = path.join(home, '.open-walnut-host', 'deps', 'deps01')
    const pkg = JSON.parse(fs.readFileSync(path.join(deps, 'package.json'), 'utf8'))
    expect(pkg.dependencies).toEqual({ ws: '^8.19.0' })
    expect(pkg.optionalDependencies).toEqual({ fsevents: '^2.3.3' })
    const args = fs.readFileSync(path.join(deps, 'node_modules', 'ws', 'args.txt'), 'utf8')
    expect(args).toContain('install --no-audit --no-fund --omit=dev')
    expect(args).not.toContain('--omit=optional')
  })

  it('a kept build survives the prune; the newest other one is kept as before', () => {
    for (const id of ['b1', 'b2', 'b3']) {
      makeBuild(id)
      fs.writeFileSync(path.join(home, `${id}.sh`), installScript(plan(id)))
      expect(sh(`sh "$HOME/${id}.sh"`).out).toContain('installed')
    }
    const root = path.join(home, '.open-walnut-host')
    expect(fs.readdirSync(path.join(root, 'app')).sort()).toEqual(['b2', 'b3'])
    makeBuild('b4')
    fs.writeFileSync(path.join(home, 'b4.sh'), installScript(plan('b4', { keep: ['b2', 'b4'] })))
    expect(sh(`sh "$HOME/b4.sh"`).out).toContain('installed')
    // b2 is kept, b3 is the newest other one; nothing else was there to remove.
    expect(fs.readdirSync(path.join(root, 'app')).sort()).toEqual(['b2', 'b3', 'b4'])
    makeBuild('b5')
    fs.writeFileSync(path.join(home, 'b5.sh'), installScript(plan('b5', { keep: ['b2'] })))
    expect(sh(`sh "$HOME/b5.sh"`).out).toContain('installed')
    // b4 is now the newest other one, b3 goes, b2 stays.
    expect(fs.readdirSync(path.join(root, 'app')).sort()).toEqual(['b2', 'b4', 'b5'])
  })

  it('refuses a kept id that is not a build id', () => {
    expect(() => installScript(plan('b1', { keep: ['ok-1', 'x; rm -rf /'] }))).toThrow(/keep has a bad build id/)
    expect(() => installScript(plan('b1', { keep: ['../up'] }))).toThrow(/keep has a bad build id/)
  })

  it('the state asks the process before its notes: one still running is running, one gone reads its note', () => {
    // An install that failed before and runs again: until it exits, it is running.
    const inc = path.join(home, '.open-walnut-host', 'incoming')
    fs.mkdirSync(inc, { recursive: true })
    fs.writeFileSync(path.join(inc, 'b1.failed'), 'the last try failed\n')
    const live = spawn('sleep', ['30'])
    try {
      fs.writeFileSync(path.join(inc, 'b1.pid'), `${live.pid}\n`)
      expect(parseInstallState(sh(stateScript('b1')).out)).toEqual({ state: 'running' })
    } finally {
      live.kill()
    }
    const gone = spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim()
    fs.writeFileSync(path.join(inc, 'b1.pid'), `${gone}\n`)
    expect(parseInstallState(sh(stateScript('b1')).out)).toMatchObject({ state: 'failed', message: 'the last try failed' })
  })

  it('an unknown build is absent', () => {
    expect(parseInstallState(sh(stateScript('nope')).out)).toEqual({ state: 'absent' })
  })
})

/** A stand-in walnut file: `--version` as the compiled file prints it (and unpacks into its data dir); as bun when BUN_BE_BUN=1. */
function standInFile(version = '0.6.14', extra = ''): Buffer {
  return Buffer.from([
    '#!/bin/sh',
    `if [ -n "\${BUN_BE_BUN:-}" ]; then echo "1.4.4"; exit 0; fi`,
    extra,
    `case "$1" in --version) mkdir -p "$OPEN_WALNUT_HOME/local/runtime/${version}-abc" && echo "${version} (80dc024a8, 2026-10-22)" ;; *) echo "walnut $*" ;; esac`,
    '',
  ].join('\n'))
}

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')
const hostRoot = () => path.join(home, '.open-walnut-host')

/** What the Mac does before it launches the script: the gz and the script in incoming/. */
function upload(id: string, file: Buffer, over: Partial<Parameters<typeof fileInstallScript>[0]> = {}): string {
  fs.mkdirSync(path.join(hostRoot(), 'incoming'), { recursive: true })
  fs.writeFileSync(path.join(hostRoot(), 'incoming', `${id}.gz`), zlib.gzipSync(file))
  const script = fileInstallScript({ id, version: '0.6.14', sha256: sha(file), host: 'Linux x86_64, glibc 2.26', ...over })
  fs.writeFileSync(path.join(hostRoot(), 'incoming', `${id}.install.sh`), script)
  return script
}

const run = (id: string, env: Record<string, string> = {}) => {
  const r = spawnSync('sh', [path.join(hostRoot(), 'incoming', `${id}.install.sh`)], { env: { HOME: home, PATH: guardedPath([bin], '/usr/bin:/bin'), ...env }, encoding: 'utf8', timeout: 30_000 })
  return { out: `${r.stdout}${r.stderr}`, code: r.status ?? -1 }
}

const failed = (id: string) => parseInstallState(sh(stateScript(id)).out)

describe('the host\'s install of the walnut file', () => {
  it('unpacks the file, checks it, runs it once in the data dir, and marks it ready last', () => {
    const file = standInFile()
    upload('0.6.14-80dc024a8', file)
    expect(run('0.6.14-80dc024a8').out).toContain('installed')
    const app = path.join(hostRoot(), 'app', '0.6.14-80dc024a8')
    expect(fs.readFileSync(path.join(app, 'walnut'))).toEqual(file)
    expect(fs.statSync(path.join(app, 'walnut')).mode & 0o777).toBe(0o755)
    expect(fs.existsSync(path.join(app, '.ready'))).toBe(true)
    // Its --version ran with the host server's data dir: the runtime tree is there, warm.
    expect(fs.existsSync(path.join(hostRoot(), 'data', 'local', 'runtime', '0.6.14-abc'))).toBe(true)
    expect(fs.readFileSync(path.join(hostRoot(), 'incoming', '0.6.14-80dc024a8.version'), 'utf8')).toMatch(/^0\.6\.14 \(80dc024a8/)
    expect(fs.existsSync(path.join(hostRoot(), 'incoming', '0.6.14-80dc024a8.gz'))).toBe(false)
    expect(fs.existsSync(`${app}.partial`)).toBe(false)
    // No Node layout: no deps, no node_modules, no package.json.
    expect(fs.existsSync(path.join(hostRoot(), 'deps'))).toBe(false)
    expect(fs.readdirSync(app).sort()).toEqual(['.ready', 'walnut'])
    expect(failed('0.6.14-80dc024a8')).toEqual({ state: 'ready' })
  })

  it('launched detached, it reads as running and then ready', () => {
    upload('b1', standInFile('0.6.14', 'sleep 1'))
    expect(sh(launchScript('b1')).out).toContain('launched')
    expect(failed('b1')).toEqual({ state: 'running' })
    let st = failed('b1')
    for (let i = 0; i < 100 && st.state === 'running'; i++) { spawnSync('sleep', ['0.1']); st = failed('b1') }
    expect(st).toEqual({ state: 'ready' })
  })

  it('a told-to-be-bun environment does not make the check talk to bun', () => {
    upload('b1', standInFile())
    expect(run('b1', { BUN_BE_BUN: '1' }).out).toContain('installed')
  })

  it('a file that arrived broken is not installed and says so', () => {
    upload('b1', standInFile(), { sha256: 'a'.repeat(64) })
    expect(run('b1').code).toBe(1)
    const st = failed('b1')
    expect(st.state === 'failed' && st.message).toMatch(/the walnut file arrived broken \(sha256 [0-9a-f]{64}, expected a{64}\)/)
    expect(fs.existsSync(path.join(hostRoot(), 'app', 'b1'))).toBe(false)
    expect(fs.existsSync(path.join(hostRoot(), 'app', 'b1.partial'))).toBe(false)
  })

  it('a host with neither sha256sum nor shasum still installs, checked by the version alone', () => {
    for (const t of ['sha256sum', 'shasum']) fs.writeFileSync(path.join(bin, t), '#!/bin/sh\nexit 127\n', { mode: 0o755 })
    upload('b1', standInFile(), { sha256: 'b'.repeat(64) })
    expect(run('b1').out).toContain('installed')
  })

  it('a file that does not start on the host names the host and what it printed', () => {
    upload('b1', Buffer.from("#!/bin/sh\necho 'walnut: /lib64/libc.so.6: version GLIBC_2.28 not found' >&2\nexit 1\n"))
    expect(run('b1').code).toBe(1)
    const st = failed('b1')
    expect(st.state === 'failed' && st.message).toMatch(/the walnut file does not start on this host \(Linux x86_64, glibc 2\.26\): walnut: \/lib64\/libc\.so\.6: version GLIBC_2\.28 not found/)
    expect(fs.existsSync(path.join(hostRoot(), 'app', 'b1'))).toBe(false)
  })

  it('a file that is another version is not installed', () => {
    upload('b1', standInFile('0.6.13'))
    expect(run('b1').code).toBe(1)
    const st = failed('b1')
    expect(st.state === 'failed' && st.message).toMatch(/the walnut file answered "0\.6\.13 \(80dc024a8, 2026-10-22\)", not Walnut 0\.6\.14/)
  })

  it('keeps this build and the newest other; a Node layout build ages out and its dependencies with it', () => {
    // A host that ran the Node layout before: app/old/dist with node_modules linked to deps/d1.
    const old = path.join(hostRoot(), 'app', 'old')
    fs.mkdirSync(path.join(old, 'dist'), { recursive: true })
    fs.mkdirSync(path.join(hostRoot(), 'deps', 'd1', 'node_modules'), { recursive: true })
    fs.symlinkSync('../../deps/d1/node_modules', path.join(old, 'node_modules'))
    fs.writeFileSync(path.join(old, '.ready'), '')
    // Older than anything installed next (the prune orders by mtime).
    const past = new Date(Date.now() - 60_000)
    fs.utimesSync(old, past, past)
    upload('b1', standInFile())
    expect(run('b1').out).toContain('installed')
    // The Node build is the newest other one: kept, and so is what it links to.
    expect(fs.readdirSync(path.join(hostRoot(), 'app')).sort()).toEqual(['b1', 'old'])
    expect(fs.existsSync(path.join(hostRoot(), 'deps', 'd1'))).toBe(true)
    upload('b2', standInFile())
    expect(run('b2').out).toContain('installed')
    expect(fs.readdirSync(path.join(hostRoot(), 'app')).sort()).toEqual(['b1', 'b2'])
    expect(fs.existsSync(path.join(hostRoot(), 'deps', 'd1'))).toBe(false)
  })

  it('a kept build survives the prune', () => {
    for (const id of ['b1', 'b2', 'b3']) {
      upload(id, standInFile(), { keep: ['b1'] })
      expect(run(id).out).toContain('installed')
    }
    expect(fs.readdirSync(path.join(hostRoot(), 'app')).sort()).toEqual(['b1', 'b2', 'b3'])
  })

  it('another root takes every path under it', () => {
    const root = path.join(home, 'srv', 'marina-host')
    fs.mkdirSync(path.join(root, 'incoming'), { recursive: true })
    const file = standInFile()
    fs.writeFileSync(path.join(root, 'incoming', 'b1.gz'), zlib.gzipSync(file))
    fs.writeFileSync(path.join(root, 'incoming', 'b1.install.sh'), fileInstallScript({ id: 'b1', version: '0.6.14', sha256: sha(file), host: 'x', root }))
    expect(sh(`sh ${JSON.stringify(path.join(root, 'incoming', 'b1.install.sh'))}`).out).toContain('installed')
    expect(fs.existsSync(path.join(root, 'app', 'b1', '.ready'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'data'))).toBe(true)
    expect(fs.existsSync(hostRoot())).toBe(false)
  })

  it('refuses what is not a build id, a sha256 or a version', () => {
    const ok = { id: 'b1', version: '0.6.14', sha256: 'a'.repeat(64), host: 'x' }
    expect(() => fileInstallScript({ ...ok, id: 'x; rm -rf /' })).toThrow(/not a build id/)
    expect(() => fileInstallScript({ ...ok, sha256: 'xyz' })).toThrow(/sha256/)
    expect(() => fileInstallScript({ ...ok, version: '1.0 $(touch x)' })).toThrow(/not a version/)
    expect(() => fileInstallScript({ ...ok, keep: ['../up'] })).toThrow(/keep has a bad build id/)
    expect(() => fileInstallScript({ ...ok, root: '/srv/$(touch x)' })).toThrow(/plain characters/)
  })
})

describe('free ports on the host', () => {
  it('asks a JS runtime there (a test app dir\'s)', async () => {
    const net = await import('node:net')
    const busy = net.createServer()
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()))
    const used = (busy.address() as { port: number }).port
    const free = parseFreePorts(sh(freePortsScript({ command: process.execPath }, [used, 47_911])).out)
    busy.close()
    expect(free.has(used)).toBe(false)
    expect(free.has(47_911)).toBe(true)
  })

  it('asks the installed walnut file as bun (BUN_BE_BUN=1)', () => {
    // As the compiled file: the runtime only when told to be bun.
    const file = path.join(bin, 'walnut')
    fs.writeFileSync(file, `#!/bin/sh\n[ "\${BUN_BE_BUN:-}" = 1 ] || { echo "not bun" >&2; exit 2; }\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 })
    const script = freePortsScript({ command: file, asBun: true }, [47_912])
    expect(script.startsWith(`BUN_BE_BUN=1 '${file}' -e `)).toBe(true)
    expect(parseFreePorts(sh(script).out)).toEqual(new Set([47_912]))
  })
})
