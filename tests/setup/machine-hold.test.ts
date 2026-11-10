/**
 * A machine on hold, or in its quiet night, starts no test run, at every test entry point
 * (src/lib/machine-hold.ts; 2026-11-09: review scripts drove Playwright WebKit and started
 * fixture servers on a Mac from 00:25 to 01:39 under its hold file: they took the browser
 * lease and ran the ephemeral launcher themselves, and neither read the hold).
 *
 * Here: the rule and its preload twin on one case table; every entry point enumerated from
 * the source reaches the check (a new vitest or Playwright config that does not fails); and
 * a real process under the preload, a real lease and a real ephemeral launch are refused.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertNoMachineHold, machineHold } from '../../src/lib/machine-hold'
import { pwSilencePreloadSource } from '../../src/providers/pw-silence-core'

const ROOT = path.resolve(__dirname, '../..')
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-machine-hold-')))
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')
/** Source with its comments taken out, so a call only a comment names does not count. */
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
const realHome = process.env.HOME
afterEach(() => { process.env.HOME = realHome })

/** A home with these files under .config/walnut. */
function home(name: string, files: Record<string, string>): string {
  const h = path.join(tmp, name)
  fs.mkdirSync(path.join(h, '.config', 'walnut'), { recursive: true })
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(h, '.config', 'walnut', f), text)
  return h
}
const at = (hour: number, minute = 0) => new Date(2026, 10, 9, hour, minute)

interface Twin { machineHold(home?: string, now?: Date): string | null }
const preloadFile = path.join(tmp, 'pw-silence-preload.cjs')
fs.writeFileSync(preloadFile, pwSilencePreloadSource())
const twin = require(preloadFile) as Twin

describe('the rule, and its preload twin', () => {
  const CASES: Array<[string, Record<string, string>, Date, RegExp | null]> = [
    ['no file', {}, at(3), null],
    ['a hold, any hour', { hold: 'Evan asleep until 08:00\nmore' }, at(14), /hold: Evan asleep until 08:00\)/],
    ['an empty hold', { hold: '' }, at(14), /~\/\.config\/walnut\/hold\)/],
    ['night-quiet at 22:00', { 'night-quiet': '' }, at(22), /22:00 to 08:00/],
    ['night-quiet at 00:50', { 'night-quiet': '' }, at(0, 50), /22:00 to 08:00/],
    ['night-quiet at 07:59', { 'night-quiet': '' }, at(7, 59), /22:00 to 08:00/],
    ['night-quiet at 08:00', { 'night-quiet': '' }, at(8), null],
    ['night-quiet at 21:59', { 'night-quiet': '' }, at(21, 59), null],
    ['both, by day', { hold: 'lent', 'night-quiet': '' }, at(12), /hold: lent/],
  ]
  for (const [name, files, now, want] of CASES) {
    it(name, () => {
      const h = home(name.replace(/\W+/g, '-'), files)
      const ts = machineHold(h, now)
      if (want) expect(ts).toMatch(want)
      else expect(ts).toBeNull()
      expect(twin.machineHold(h, now), 'the preload says the same').toBe(ts)
    })
  }
  it('there is no override but the file', () => {
    const src = read('src/lib/machine-hold.ts')
    expect(src).not.toMatch(/process\.env/)
  })
})

describe('every test entry point reaches it (enumerated from the source)', () => {
  const tracked = (globs: string[]) =>
    execFileSync('git', ['ls-files', ...globs], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  const body = (file: string, head: RegExp) => {
    const s = read(file)
    const i = s.search(head)
    expect(i, `${file} defines ${head}`).toBeGreaterThan(-1)
    return s.slice(i, s.indexOf('\n}\n', i))
  }
  // Configs that run no browser, server or Walnut code: listed with why.
  const NOT_TEST_RUNS: Record<string, string> = {
    'infra/vitest.config.ts': 'its own package: synthesizes CloudFormation templates in-process, no browser, server or sound',
  }

  it('the checks themselves', () => {
    expect(body('tests/setup/worker-budget.ts', /export function maxWorkers\(/)).toContain('assertNoMachineHold()')
    expect(body('tests/e2e/browser/pw-concurrency.ts', /export function perRunWorkers\(/)).toContain('assertNoMachineHold()')
    expect(body('tests/e2e/browser/pw-concurrency.ts', /export function acquireSync\(/)).toContain('assertNoMachineHold()')
    expect(body('tests/e2e/browser/pw-gate.ts', /export function engageGate\(/)).toContain('assertNoMachineHold()')
    expect(body('tests/setup/global-setup.ts', /export async function setup\(/)).toContain('assertNoMachineHold()')
    const launcher = body('src/commands/web-ephemeral.ts', /export async function runEphemeralLauncher\(/)
    expect(launcher.indexOf('machineHold()')).toBeGreaterThan(-1)
    expect(launcher.indexOf('machineHold()'), 'before it makes any dir').toBeLessThan(launcher.indexOf('reapStaleEphemeralDirs('))
  })

  it('every vitest config sets its workers through maxWorkers() or runs the global setup, itself or through the config it extends', () => {
    const configs = tracked(['vitest*.config.*', '*/vitest*.config.*', '**/vitest*.config.*']).filter((f) => !f.includes('node_modules/'))
    expect(configs).toContain('vitest.quick.config.ts')
    const reaches = (f: string, seen = new Set<string>()): boolean => {
      if (seen.has(f)) return false
      seen.add(f)
      const s = code(f)
      if (/\bmaxWorkers\(\)/.test(s) || /globalSetup:\s*\[[^\]]*tests\/setup\/global-setup\.ts/.test(s)) return true
      for (const m of s.matchAll(/from '(\.\/vitest[^']*config)(\.js|\.ts)?'/g)) {
        const next = path.join(path.dirname(f), m[1] + '.ts')
        if (fs.existsSync(path.join(ROOT, next)) && reaches(next, seen)) return true
      }
      return false
    }
    const missing = [...new Set(configs)].filter((f) => !NOT_TEST_RUNS[f] && !reaches(f))
    expect(missing, 'a vitest config that a held machine would run: call maxWorkers(), run tests/setup/global-setup.ts, or extend a config that does').toEqual([])
  })

  it('every Playwright config engages the gate, which takes the lease', () => {
    const configs = tracked(['*.config.ts', '**/*.config.ts', '*.config.mts', '**/*.config.mts'])
      .filter((f) => !f.includes('node_modules/') && /@playwright\/test/.test(read(f)))
    expect(configs).toContain('playwright.config.ts')
    // Itself, or by extending a config that does (an import of it engages the gate when it loads).
    const reaches = (f: string, seen = new Set<string>()): boolean => {
      if (seen.has(f)) return false
      seen.add(f)
      const src = code(f)
      if (/\bengageGate\(/.test(src)) return true
      return [...src.matchAll(/from '(\.{1,2}\/[^']*playwright\.config)(\.js|\.ts)?'/g)].some((m) => reaches(path.join(path.dirname(f), m[1] + '.ts'), seen))
    }
    expect(configs.filter((f) => !reaches(f))).toEqual([])
  })

  it('every Playwright browser a session launches passes the preload\'s check, whatever engine', () => {
    const src = pwSilencePreloadSource()
    expect(src).toContain('else if (isBrowserTypeServer(filename)) holdBrowserTypes(module.exports);')
    expect(src).toMatch(/install\(module\.exports\); holdBrowsers\(root\); quietWebkit\(root\)/)
    // Playwright's own launch path: every engine's launch, persistent context and launchServer
    // reaches BrowserType._prepareToLaunch.
    const bt = fs.readFileSync(path.join(path.dirname(require.resolve('playwright-core/package.json', { paths: [ROOT] })), 'lib', 'server', 'browserType.js'), 'utf8')
    expect(bt).toMatch(/async _launchProcess\([^)]*\) \{[\s\S]*?this\._prepareToLaunch\(/)
    // The committed copy for the Mac queue's runners is the same text.
    expect(read('tests/e2e/browser/pw-silence-preload.cjs')).toBe(src)
  })
})

describe('refused for real', () => {
  it('a lease, a gate and a worker budget on a held machine', async () => {
    process.env.HOME = home('lease', { hold: 'asleep' })
    expect(() => assertNoMachineHold()).toThrow(/\[machine-hold\] This test run did not start: .*hold: asleep/)
    const { acquireSync } = await import('../e2e/browser/pw-concurrency')
    expect(() => acquireSync(3457, 1)).toThrow(/\[machine-hold\]/)
    const { maxWorkers } = await import('./worker-budget')
    expect(() => maxWorkers()).toThrow(/\[machine-hold\]/)
  })

  it('a Playwright script under the preload launches no browser on a held machine, and does by day', () => {
    const script = path.join(tmp, 'launch.cjs')
    fs.writeFileSync(script, `const { chromium } = require(${JSON.stringify(require.resolve('playwright-core', { paths: [ROOT] }))})
      chromium.launch().then(async (b) => { await b.close(); console.log('LAUNCHED') }, (e) => { console.log('REFUSED ' + e.message) })`)
    const run = (h: string) => spawnSync(process.execPath.includes('bun') ? 'node' : process.execPath, ['--require', preloadFile, script], {
      cwd: tmp, encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: h },
    }).stdout
    expect(run(home('held-run', { hold: 'asleep' }))).toMatch(/REFUSED [\s\S]*\[machine-hold\] This browser did not start: .*hold: asleep/)
    const free = run(home('free-run', {}))
    expect(free, 'with no hold the same script runs (or fails for its own reasons, never the hold)').not.toMatch(/machine-hold/)
  }, 90_000)

  // Node under the preload, as a Walnut session's processes run.
  const underPreload = (name: string, body: string, h: string, argv1?: string) => {
    const script = argv1 ?? path.join(tmp, name)
    fs.mkdirSync(path.dirname(script), { recursive: true })
    fs.writeFileSync(script, body)
    return spawnSync('node', ['--require', preloadFile, script], { cwd: tmp, encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: h } }).stdout
  }
  const core = path.dirname(require.resolve('playwright-core/package.json', { paths: [ROOT] }))

  it('a Mac WebKit launch, through the no-activation wrapper stacked on the hold, is refused too', () => {
    // The WebKit wrapper (src/providers/pw-noactivate-core.ts) captures the base launch step when
    // webkit.js loads; webkit.js loads browserType.js first, so the base it captures holds.
    const out = underPreload('webkit-held.cjs', `Object.defineProperty(process, 'platform', { value: 'darwin' })
      require(${JSON.stringify(core)})
      const { WebKit } = require(${JSON.stringify(path.join(core, 'lib/server/webkit/webkit.js'))})
      const own = Object.getOwnPropertySymbols(WebKit.prototype).map(String)
      console.log('WRAPPED ' + own.includes('Symbol(walnut.pwSilence.noActivate)'))
      WebKit.prototype._prepareToLaunch.call({}, {}).then(() => console.log('PREPARED'), (e) => console.log('REFUSED ' + e.message))`,
      home('webkit-held', { hold: 'asleep' }))
    expect(out).toContain('WRAPPED true')
    expect(out).toMatch(/REFUSED \[machine-hold\] This browser did not start: .*hold: asleep/)
  })

  it("the deploy's first-paint check still launches its browser on a held machine (it is no test run)", () => {
    // An ES module like the real one, so its require comes from createRequire.
    const body = `import { createRequire } from 'node:module'
      const require = createRequire(import.meta.url)
      const { BrowserType } = require(${JSON.stringify(path.join(core, 'lib/server/browserType.js'))})
      try { await BrowserType.prototype._prepareToLaunch.call({ _name: 'x' }, {}) } catch (e) { if (/machine-hold/.test(e.message)) { console.log('REFUSED'); process.exit(0) } }
      console.log('PASSED-HOLD')`
    const h = home('deploy', { hold: 'asleep' })
    expect(underPreload('', body, h, path.join(tmp, 'repo', 'scripts', 'devprod-render-check.mjs'))).toContain('PASSED-HOLD')
    expect(underPreload('other-check.mjs', body, h)).toContain('REFUSED')
  })

  it('the ephemeral test server', () => {
    const h = home('ephemeral', { hold: 'asleep' })
    const r = spawnSync('bun', [path.join(ROOT, 'src/cli.ts'), 'web', '--ephemeral'], {
      cwd: ROOT, encoding: 'utf8', timeout: 90_000, env: { ...process.env, HOME: h, OPEN_WALNUT_HOME: path.join(h, '.open-walnut') },
    })
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/"reason":"The test server did not start: this machine holds every new test run for now \(~\/\.config\/walnut\/hold: asleep\)/)
    expect(fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith(`open-walnut-${process.pid}-`)), 'no snapshot dir made').toEqual([])
  }, 120_000)
})
