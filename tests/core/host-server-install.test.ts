/**
 * The host server's install scripts (src/core/host-server/install.ts), run for
 * real with `sh` in a temp HOME: a fake build tarball, a fake Node and npm.
 * What a real host adds (the npm registry, a native compile) is the live check.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import {
  freePortsScript, installScript, launchScript, nodeMajor, parseFreePorts, parseInstallState, stateScript,
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

describe('the install script', () => {
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

  it('an unknown build is absent', () => {
    expect(parseInstallState(sh(stateScript('nope')).out)).toEqual({ state: 'absent' })
  })
})

describe('host checks', () => {
  it('reads a node version', () => {
    expect(nodeMajor('v24.3.0')).toBe(24)
    expect(nodeMajor('node: /lib64/libc.so.6: version `GLIBC_2.28\' not found')).toBeNull()
  })

  it('finds free loopback ports with the host\'s node', async () => {
    const net = await import('node:net')
    const busy = net.createServer()
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()))
    const used = (busy.address() as { port: number }).port
    const free = parseFreePorts(sh(freePortsScript(path.join(bin, 'node'), [used, 0 || 47_911])).out)
    busy.close()
    expect(free.has(used)).toBe(false)
    expect(free.has(47_911)).toBe(true)
  })
})
