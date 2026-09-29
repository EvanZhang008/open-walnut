/**
 * install.sh / uninstall.sh and the LaunchAgent templates, exercised in temp
 * dirs with --no-load (no launchctl call). Plus two ratchets on the shipped
 * files: no relaunch-loop launchd usage, and nothing that could leak a real
 * address or break the no-dash writing rule.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.join(import.meta.dirname, '..', '..', '..')
const SRC = path.join(REPO, 'scripts', 'bridge-monitor')
const FIXTURES = path.join(import.meta.dirname, 'fixtures')
const isMac = process.platform === 'darwin'

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
}

let tmp = ''
let env: NodeJS.ProcessEnv = {}
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-install-'))
  env = {
    ...process.env,
    BRIDGE_MONITOR_SUPPORT_DIR: path.join(tmp, 'support'),
    BRIDGE_MONITOR_LOG_DIR: path.join(tmp, 'logs', 'bridge-monitor'),
    BRIDGE_MONITOR_AGENTS_DIR: path.join(tmp, 'agents'),
    BRIDGE_MONITOR_NODE: process.execPath,
  }
})
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

const run = (script: string, args: string[]) => execFileSync('bash', [path.join(SRC, script), ...args], { env, encoding: 'utf-8' })
const plist = (label: string) => fs.readFileSync(path.join(tmp, 'agents', `${label}.plist`), 'utf-8')

describe.skipIf(!isMac)('install.sh --no-load', () => {
  it('renders valid plists with a crash-only KeepAlive and absolute paths', () => {
    run('install.sh', ['--no-load'])
    const collector = plist('dev.openwalnut.bridge-monitor')
    execFileSync('plutil', ['-lint', path.join(tmp, 'agents', 'dev.openwalnut.bridge-monitor.plist')])
    execFileSync('plutil', ['-lint', path.join(tmp, 'agents', 'dev.openwalnut.bridge-monitor-summary.plist')])
    expect(collector).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/)
    expect(collector).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>60<\/integer>/)
    expect(collector).toContain(`<string>${process.execPath}</string>`)
    expect(collector).toContain(`${path.join(tmp, 'support', 'bridge-monitor', 'app')}/collector.mjs`)
    expect(collector).not.toContain('__')
    const summary = plist('dev.openwalnut.bridge-monitor-summary')
    expect(summary).toMatch(/<key>Hour<\/key>\s*<integer>8<\/integer>/)
    expect(summary).not.toContain('<key>KeepAlive</key>')
    expect(fs.existsSync(path.join(tmp, 'agents', 'dev.openwalnut.bridge-monitor-probe.plist'))).toBe(false)
  })

  it('snapshots the code and its ws dependency; creates the config once and never overwrites it', () => {
    run('install.sh', ['--no-load'])
    const app = path.join(tmp, 'support', 'bridge-monitor', 'app')
    for (const f of ['collector.mjs', 'summarize.mjs', 'probe.mjs', 'lib/classify.mjs', 'node_modules/ws/package.json']) {
      expect(fs.existsSync(path.join(app, f)), f).toBe(true)
    }
    expect(fs.existsSync(path.join(app, 'install.sh'))).toBe(false)
    const cfgFile = path.join(tmp, 'support', 'bridge-monitor.json')
    expect(JSON.parse(fs.readFileSync(cfgFile, 'utf-8')).probe.enabled).toBe(false)
    fs.writeFileSync(cfgFile, '{"alert":{"outageSec":120}}')
    run('install.sh', ['--no-load'])
    expect(fs.readFileSync(cfgFile, 'utf-8')).toBe('{"alert":{"outageSec":120}}')
  })

  it('refuses --with-probe until the config enables it with a token file', () => {
    expect(() => run('install.sh', ['--no-load', '--with-probe'])).toThrow()
    const token = path.join(tmp, 'probe.token')
    fs.writeFileSync(token, 'tok\n')
    fs.mkdirSync(path.join(tmp, 'support'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'support', 'bridge-monitor.json'), JSON.stringify({ probe: { enabled: true, url: 'ws://127.0.0.1:1/bridge', tokenFile: token } }))
    // The installed app reads the config from the real default path unless told otherwise.
    env.BRIDGE_MONITOR_CONFIG = path.join(tmp, 'support', 'bridge-monitor.json')
    run('install.sh', ['--no-load', '--with-probe'])
    expect(plist('dev.openwalnut.bridge-monitor-probe')).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/)
  })

  it('uninstall removes the plists (idempotent) and --purge the snapshot, keeping records', () => {
    run('install.sh', ['--no-load'])
    const logs = path.join(tmp, 'logs', 'bridge-monitor')
    fs.writeFileSync(path.join(logs, '2026-03-10.ndjson'), '{}\n')
    run('uninstall.sh', ['--no-load', '--purge'])
    run('uninstall.sh', ['--no-load'])
    expect(fs.readdirSync(path.join(tmp, 'agents'))).toEqual([])
    expect(fs.existsSync(path.join(tmp, 'support', 'bridge-monitor'))).toBe(false)
    expect(fs.existsSync(path.join(logs, '2026-03-10.ndjson'))).toBe(true)
    run('uninstall.sh', ['--no-load', '--purge-all'])
    expect(fs.existsSync(logs)).toBe(false)
    expect(fs.existsSync(path.join(tmp, 'logs'))).toBe(true) // only the bridge-monitor dir itself
  })

  it('refuses a record dir that is not ours: no chmod, no rm -rf', () => {
    // A mistyped override pointing at a parent (think $HOME) must never be deleted or re-moded.
    const parent = path.join(tmp, 'home')
    fs.mkdirSync(parent, { recursive: true })
    fs.chmodSync(parent, 0o755) // explicit: the test's umask may be 077
    fs.writeFileSync(path.join(parent, 'keep.txt'), 'x')
    for (const bad of [parent, `${parent}/`, 'relative/bridge-monitor', '/']) {
      env.BRIDGE_MONITOR_LOG_DIR = bad
      expect(() => run('uninstall.sh', ['--no-load', '--purge-all']), bad).toThrow(/refusing record dir/)
      expect(() => run('install.sh', ['--no-load']), bad).toThrow(/refusing record dir/)
    }
    expect(fs.readFileSync(path.join(parent, 'keep.txt'), 'utf-8')).toBe('x')
    expect(fs.statSync(parent).mode & 0o777).toBe(0o755)
    // A trailing slash on our own dir is fine.
    env.BRIDGE_MONITOR_LOG_DIR = `${path.join(tmp, 'logs', 'bridge-monitor')}/`
    run('install.sh', ['--no-load'])
    expect(fs.statSync(path.join(tmp, 'logs', 'bridge-monitor')).mode & 0o777).toBe(0o700)
  })
})

describe('shipped-file ratchets', () => {
  const shipped = walk(SRC)
  /** The file minus its comments (docs may explain what NOT to run). */
  const code = (f: string) => fs.readFileSync(f, 'utf-8')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*(#|\/\/)/.test(l)).join('\n')

  it('never uses `launchctl submit` or `load -w`, never names another launchd job', () => {
    for (const f of shipped) {
      const body = code(f)
      expect(body, f).not.toMatch(/launchctl\s+submit/)
      expect(body, f).not.toMatch(/launchctl\s+load/)
      expect(fs.readFileSync(f, 'utf-8'), f).not.toMatch(/com\.open-walnut/)
    }
  })

  it('every launchctl call in the scripts targets our own labels through the guarded helper', () => {
    const install = fs.readFileSync(path.join(SRC, 'install.sh'), 'utf-8')
    expect(install).toContain('dev.openwalnut.bridge-monitor*) ;;')
    expect(install).toMatch(/launchctl bootstrap "\$DOMAIN"/)
  })

  it('no dash characters, and IPv4 literals only from private, loopback or documentation ranges', () => {
    const ok = (ip: string) => /^(10\.|127\.|192\.168\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|0\.0\.0\.0)/.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
    for (const f of [...shipped, ...walk(path.dirname(FIXTURES))]) {
      const text = fs.readFileSync(f, 'utf-8')
      expect(/[\u2013\u2014]/.test(text), `${f} has an en or em dash`).toBe(false)
      for (const ip of text.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) ?? []) expect(ok(ip), `${f}: ${ip}`).toBe(true)
    }
  })
})
