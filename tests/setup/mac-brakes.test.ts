import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { assertMacBrakes, macBrakeViolations, realCi } from './mac-brakes.js'
import { maxWorkers } from './worker-budget.js'
import { perRunWorkers } from '../e2e/browser/pw-concurrency.js'

// 2026-11-03: Mac WebKit runs with PW_IGNORE_LOAD=1 and PW_TEST_PORT=3491 at load 160 to 469
// came before the Mac's WindowServer crash. Every way to turn a brake off is refused on darwin
// at the test entry points; Linux and a hosted CI runner run as before.

const mac = (env: NodeJS.ProcessEnv, argv: string[] = []) =>
  macBrakeViolations({ platform: 'darwin', env, argv, dirExists: () => true })
const linux = (env: NodeJS.ProcessEnv, argv: string[] = []) =>
  macBrakeViolations({ platform: 'linux', env, argv, dirExists: () => true })

const BYPASSES: Array<[string, NodeJS.ProcessEnv, string[], string]> = [
  ['PW_IGNORE_LOAD=1', { PW_IGNORE_LOAD: '1' }, [], 'PW_IGNORE_LOAD'],
  ['PW_IGNORE_LOAD=true', { PW_IGNORE_LOAD: 'true' }, [], 'PW_IGNORE_LOAD'],
  ['PW_NO_GATE=1', { PW_NO_GATE: '1' }, [], 'PW_NO_GATE'],
  ['PW_TEST_PORT=3491', { PW_TEST_PORT: '3491' }, [], 'PW_TEST_PORT=3491'],
  ['CI=1', { CI: '1' }, [], 'CI turns off'],
  ['CI=true', { CI: 'true' }, [], 'CI turns off'],
  ['a faked CI runner (GITHUB_ACTIONS=true, no ImageOS)', { CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_TEMP: '/tmp' }, [], 'CI turns off'],
  ['WALNUT_TEST_WORKERS=2', { WALNUT_TEST_WORKERS: '2' }, [], 'WALNUT_TEST_WORKERS=2'],
  ['PW_WORKERS=4', { PW_WORKERS: '4' }, [], 'PW_WORKERS=4'],
  ['--workers=3', {}, ['node', 'playwright', 'test', '--workers=3'], '--workers 3'],
  ['--workers 2', {}, ['node', 'playwright', 'test', '--workers', '2'], '--workers 2'],
  ['-j 2', {}, ['node', 'playwright', 'test', '-j', '2'], '-j 2'],
  ['--maxWorkers=50%', {}, ['node', 'vitest', 'run', '--maxWorkers=50%'], '--maxWorkers 50%'],
  ['--max-workers=4', {}, ['node', 'vitest', '--max-workers=4'], '--max-workers 4'],
]

describe('mac brakes: every bypass is refused on darwin', () => {
  for (const [name, env, argv, words] of BYPASSES) {
    it(`refuses ${name} on darwin and lets it run on linux`, () => {
      const v = mac(env, argv)
      expect(v.length).toBeGreaterThan(0)
      expect(v.join('\n')).toContain(words)
      expect(linux(env, argv)).toEqual([])
    })
  }

  it('names every brake a run turns off, not only the first', () => {
    const v = mac({ PW_IGNORE_LOAD: '1', PW_TEST_PORT: '3491', PW_WORKERS: '1' })
    expect(v).toHaveLength(2)
  })

  it('lets the sanctioned Mac run through: one worker, the lease and the load wait kept', () => {
    expect(mac({})).toEqual([])
    expect(mac({ PW_WORKERS: '1', PW_TEST_PORT: '3457', PW_IGNORE_LOAD: '0', WALNUT_TEST_WORKERS: '1' })).toEqual([])
    expect(mac({}, ['node', 'playwright', 'test', '--workers=1', '--project', 'webkit'])).toEqual([])
    expect(mac({}, ['node', 'vitest', 'run', '--maxWorkers', '1'])).toEqual([])
  })

  it('lets a hosted CI runner through and only a real one', () => {
    const runner = { CI: 'true', GITHUB_ACTIONS: 'true', ImageOS: 'macos15', RUNNER_TEMP: '/Users/runner/work/_temp' }
    expect(mac({ ...runner, PW_WORKERS: '4' })).toEqual([])
    expect(realCi(runner, () => true)).toBe(true)
    expect(realCi(runner, () => false)).toBe(false)
    expect(realCi({ ...runner, ImageOS: '' }, () => true)).toBe(false)
    expect(realCi({ ...runner, GITHUB_ACTIONS: 'false' }, () => true)).toBe(false)
    expect(realCi({ CI: '1' }, () => true)).toBe(false)
  })

  it('WALNUT_MAC_BRAKES=off lets a person run with a brake off on purpose', () => {
    expect(mac({ WALNUT_MAC_BRAKES: 'off', PW_IGNORE_LOAD: '1' })).toEqual([])
  })

  it('the refusal says what to do: Linux, or one worker waiting in the :3457 queue', () => {
    expect(() =>
      assertMacBrakes({ platform: 'darwin', env: { PW_TEST_PORT: '3491' }, argv: [], dirExists: () => true }),
    ).toThrow(/PW_TEST_PORT=3491[\s\S]*Run it on Linux[\s\S]*:3457 queue/)
  })
})

describe('mac brakes: both test entry points stop there', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const saved = { ...process.env }
  const asPlatform = (p: NodeJS.Platform) => Object.defineProperty(process, 'platform', { ...realPlatform, value: p })
  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform)
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })
  const clean = () => {
    for (const k of ['CI', 'GITHUB_ACTIONS', 'ImageOS', 'RUNNER_TEMP', 'PW_IGNORE_LOAD', 'PW_NO_GATE', 'PW_TEST_PORT', 'PW_WORKERS', 'WALNUT_TEST_WORKERS', 'WALNUT_MAC_BRAKES'])
      delete process.env[k]
  }

  it('vitest maxWorkers() refuses CI=1 on darwin and gives 4 on linux', () => {
    clean()
    process.env.CI = '1'
    asPlatform('darwin')
    expect(() => maxWorkers()).toThrow(/CI turns off/)
    asPlatform('linux')
    expect(maxWorkers()).toBe(4)
  })

  it('playwright perRunWorkers() refuses PW_IGNORE_LOAD on darwin, runs one browser there by default', () => {
    clean()
    asPlatform('darwin')
    process.env.PW_IGNORE_LOAD = '1'
    expect(() => perRunWorkers()).toThrow(/PW_IGNORE_LOAD/)
    delete process.env.PW_IGNORE_LOAD
    expect(perRunWorkers()).toBe(1)
    asPlatform('linux')
    process.env.PW_IGNORE_LOAD = '1'
    expect(perRunWorkers()).toBeGreaterThanOrEqual(1)
  })

  it('each entry point checks before it reads any knob (source ratchet)', () => {
    const body = (file: string, fn: string) => {
      const s = fs.readFileSync(new URL(file, import.meta.url), 'utf8')
      const i = s.indexOf(`export function ${fn}(`)
      return s.slice(i, s.indexOf('\n}\n', i))
    }
    for (const [file, fn] of [['./worker-budget.ts', 'maxWorkers'], ['../e2e/browser/pw-concurrency.ts', 'perRunWorkers']]) {
      const b = body(file, fn)
      const code = b.split('\n').slice(1).filter((l) => l.trim() && !l.trim().startsWith('//'))
      expect(code[0]?.trim(), `${fn} first statement`).toBe('assertMacBrakes()')
    }
  })
})
