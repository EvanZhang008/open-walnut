/**
 * On a Mac, no WebKit test browser ever becomes the frontmost app (src/providers/pw-noactivate-core.ts;
 * 2026-11-08: two tasks' headless WebKit browsers took the front from the person at the Mac 8 times in
 * 8 seconds). The preload points every WebKit launch at a runner that loads the no-activation library.
 * Checked on a Mac by the system log: with the runner, NSRunningApplication.activate on the browser
 * gave no SETFRONT; without it (WALNUT_PW_ACTIVATE=1), it did. Here: the launch rewrite, the runner
 * it writes, and that every way a Playwright run starts goes through it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PW_NOACTIVATE_M } from '../../src/providers/pw-noactivate-core'
import { pwSilencePreloadSource } from '../../src/providers/pw-silence-core'

const ROOT = path.resolve(__dirname, '../..')
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-pw-noactivate-')))
const realPlatform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform })
  delete process.env.WALNUT_PW_ACTIVATE
  vi.restoreAllMocks()
})

type Launch = (...args: unknown[]) => unknown
interface FakeWebkit { executablePath(): string; launch: Launch; launchPersistentContext: Launch; launchServer: Launch; calls: unknown[][] }

/** A copy of the preload in its own folder (it writes its runner beside itself), and a fake WebKit build. */
function setup(name: string, withLibrary = true) {
  const dir = path.join(tmp, name)
  fs.mkdirSync(path.join(dir, 'browser', 'Playwright.app', 'Contents', 'MacOS'), { recursive: true })
  const app = path.join(dir, 'browser', 'Playwright.app', 'Contents', 'MacOS', 'Playwright')
  // Stands in for the browser: prints what the runner hands it.
  fs.writeFileSync(app, '#!/bin/sh\nprintf "%s|%s|%s|%s" "$DYLD_INSERT_LIBRARIES" "$DYLD_FRAMEWORK_PATH" "$DYLD_LIBRARY_PATH" "$*"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'browser', 'pw_run.sh'), '#!/bin/sh\n', { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'pw-silence-preload.cjs'), pwSilencePreloadSource())
  const lib = path.join(dir, 'pw-noactivate', `noactivate-${createHash('sha256').update(PW_NOACTIVATE_M).digest('hex').slice(0, 16)}.dylib`)
  if (withLibrary) { fs.mkdirSync(path.dirname(lib), { recursive: true }); fs.writeFileSync(lib, 'dylib') }
  const preload = require(path.join(dir, 'pw-silence-preload.cjs')) as { quietWebkit(core: unknown): boolean }
  const calls: unknown[][] = []
  const record = (...args: unknown[]) => { calls.push(args); return 'launched' }
  const webkit: FakeWebkit = {
    executablePath: () => path.join(dir, 'browser', 'pw_run.sh'),
    launch: record, launchPersistentContext: record, launchServer: record, calls,
  }
  return { dir, app, lib, preload, webkit, core: { webkit, chromium: { launch: record } } }
}

describe('a Mac WebKit test browser starts through the no-activation runner', () => {
  it('every WebKit launch on a Mac gets the runner as its executable, the options kept', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const s = setup('mac')
    expect(s.preload.quietWebkit(s.core)).toBe(true)
    expect(s.preload.quietWebkit(s.core), 'once per library').toBe(false)
    expect(s.webkit.launch({ headless: true, env: { A: '1' } })).toBe('launched')
    s.webkit.launchPersistentContext('/profile', { headless: true })
    s.webkit.launchServer()
    const [launch, persistent, server] = s.webkit.calls
    const run = (launch[0] as { executablePath: string }).executablePath
    expect(run).toMatch(new RegExp(`^${s.dir}/pw-noactivate/webkit-[0-9a-f]{16}\\.sh$`))
    expect(launch[0]).toMatchObject({ headless: true, env: { A: '1' } })
    expect(persistent[0]).toBe('/profile')
    expect((persistent[1] as { executablePath: string }).executablePath).toBe(run)
    expect((server[0] as { executablePath: string }).executablePath).toBe(run)
    // The runner starts this build's browser with the library loaded and every argument passed on.
    expect(execFileSync(run, ['--headless', '--inspector-pipe'], { encoding: 'utf8' }))
      .toBe(`${s.lib}|${path.join(s.dir, 'browser')}|${path.join(s.dir, 'browser')}|--headless --inspector-pipe`)
  })

  it('leaves a launch that names its own executable, another OS, and WALNUT_PW_ACTIVATE=1 alone', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const s = setup('own')
    s.preload.quietWebkit(s.core)
    s.webkit.launch({ executablePath: '/own/browser' })
    expect(s.webkit.calls[0][0]).toEqual({ executablePath: '/own/browser' })

    const off = setup('off')
    process.env.WALNUT_PW_ACTIVATE = '1'
    expect(off.preload.quietWebkit(off.core)).toBe(false)
    delete process.env.WALNUT_PW_ACTIVATE

    Object.defineProperty(process, 'platform', { value: 'linux' })
    const linux = setup('linux')
    expect(linux.preload.quietWebkit(linux.core)).toBe(false)
    linux.webkit.launch({ headless: true })
    expect(linux.webkit.calls[0][0]).toEqual({ headless: true })
  })

  it('with no library and no tools to build one, the launch goes on as it was, with one warning', () => {
    if (fs.existsSync('/Library/Developer/CommandLineTools/usr/bin/clang')) return
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = setup('no-tools', false)
    s.preload.quietWebkit(s.core)
    s.webkit.launch({ headless: true })
    s.webkit.launch({ headless: true })
    expect(s.webkit.calls.map((c) => c[0])).toEqual([{ headless: true }, { headless: true }])
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('may come to the front'))).toHaveLength(1)
  })

  it('the library makes the app background-only and drops its own requests to activate', () => {
    expect(PW_NOACTIVATE_M).toMatch(/NSApplicationActivationPolicyProhibited/)
    for (const sel of ['setActivationPolicy:', 'activateIgnoringOtherApps:', '@"activate"']) expect(PW_NOACTIVATE_M).toContain(sel)
    expect(PW_NOACTIVATE_M).toMatch(/__attribute__\(\(constructor\)\)/)
  })
})

describe('every way a Playwright run starts goes through it', () => {
  it('the preload calls it for every Playwright library it sees, beside the silencer', () => {
    expect(pwSilencePreloadSource()).toContain('install(module.exports); quietWebkit(module.exports);')
  })
  it('the repo silencer every Playwright config imports calls it, even when a runner\'s older preload silenced the pages first', () => {
    // 2026-11-09: a Mac run's preload came from the Mac's main; it set the silenced flag, and a call
    // inside the flag's block never ran.
    const src = fs.readFileSync(path.join(ROOT, 'tests/e2e/browser/pw-silence.ts'), 'utf8')
    const flagBlockEnd = src.indexOf('\n}\n', src.indexOf('if (!g[FLAG])'))
    expect(flagBlockEnd).toBeGreaterThan(0)
    expect(src.indexOf(".quietWebkit(req('playwright-core'))")).toBeGreaterThan(flagBlockEnd)
  })
})
