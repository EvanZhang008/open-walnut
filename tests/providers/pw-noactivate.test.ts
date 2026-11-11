/**
 * On a Mac, no WebKit test browser ever becomes the frontmost app (src/providers/pw-noactivate-core.ts;
 * 2026-11-08: two tasks' headless WebKit browsers took the front from the person at the Mac 8 times in
 * 8 seconds). The preload makes Playwright's own WebKit browser type start every browser through a
 * runner that loads the no-activation library. Checked on a Mac by the system log: with the runner,
 * NSRunningApplication.activate on the browser gave no SETFRONT; without it (WALNUT_PW_ACTIVATE=1), it
 * did. Here: the rewrite of the executable, the runner it writes, and every way it is reached.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { PW_CLANG_TOOLS, PW_NOACTIVATE_M } from '../../src/providers/pw-noactivate-core'
import { pwSilencePreloadSource } from '../../src/providers/pw-silence-core'

const ROOT = path.resolve(__dirname, '../..')
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-pw-noactivate-')))
const realPlatform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform })
  delete process.env.WALNUT_PW_ACTIVATE
  vi.restoreAllMocks()
})

interface Preload {
  quietWebkitServer(mod: unknown): boolean
  quietWebkit(root: string): boolean
  isWebkitServer(file: string): boolean
}
interface Prepared { executable: string; browserArguments: string[] }
type ServerWebKit = { new (): { _prepareToLaunch(options?: Record<string, unknown>): Promise<Prepared> } }

/** Stands in for lib/server/webkit/webkit.js: picks the installed build's pw_run.sh, as Playwright does. */
const FAKE_SERVER = (pwRun: string) => `class BrowserType { async _prepareToLaunch(options) {
  return { executable: (options && options.executablePath) || ${JSON.stringify(pwRun)}, browserArguments: ['--headless'] } } }
class WebKit extends BrowserType { amendEnvironment(env) { return { ...env, CURL: 'x' } } }
module.exports = { WebKit }
`

const FAKE_BROWSER_SH = '#!/bin/sh\nprintf "%s|%s|%s|%s" "$DYLD_INSERT_LIBRARIES" "$DYLD_FRAMEWORK_PATH" "$DYLD_LIBRARY_PATH" "$*"\n'
const FAKE_BROWSER_C = `#include <stdio.h>
#include <stdlib.h>
static const char *v(const char *k) { const char *s = getenv(k); return s ? s : ""; }
int main(int argc, char **argv) {
  printf("%s|%s|%s|", v("DYLD_INSERT_LIBRARIES"), v("DYLD_FRAMEWORK_PATH"), v("DYLD_LIBRARY_PATH"));
  for (int i = 1; i < argc; i++) printf(i > 1 ? " %s" : "%s", argv[i]);
  return 0;
}
`
const MAC = realPlatform === 'darwin'
const CLANG = PW_CLANG_TOOLS.find(([c, sdk]) => fs.existsSync(c) && fs.existsSync(sdk))
/**
 * On a Mac, the stand-in browser is a compiled program and the library a real (empty) one: macOS drops
 * every DYLD_ variable at the exec of a protected binary such as /bin/sh, so a shell stand-in never sees
 * them, and dyld ends a process whose inserted library is not a Mach-O file. Built once per run.
 */
let macFakes: { browser: string; lib: string } | undefined
function macFakeBuild(): { browser: string; lib: string } {
  if (macFakes) return macFakes
  const [clang, sdk] = CLANG!
  const d = path.join(tmp, 'fakes')
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'browser.c'), FAKE_BROWSER_C)
  fs.writeFileSync(path.join(d, 'lib.c'), 'int walnut_noactivate_stand_in;\n')
  execFileSync(clang, ['-isysroot', sdk, '-o', path.join(d, 'browser'), path.join(d, 'browser.c')], { stdio: 'pipe', timeout: 120_000 })
  execFileSync(clang, ['-isysroot', sdk, '-dynamiclib', '-o', path.join(d, 'lib.dylib'), path.join(d, 'lib.c')], { stdio: 'pipe', timeout: 120_000 })
  macFakes = { browser: path.join(d, 'browser'), lib: path.join(d, 'lib.dylib') }
  return macFakes
}
/** A test that runs the stand-in browser through the runner: a Mac needs a clang to build it. */
const itRunsBrowser = it.skipIf(MAC && !CLANG)

/** A copy of the preload in its own folder (it writes its runner beside itself), a fake WebKit build and a fake Playwright. */
function setup(name: string, withLibrary = true) {
  const dir = path.join(tmp, name)
  const browser = path.join(dir, 'browser')
  fs.mkdirSync(path.join(browser, 'Playwright.app', 'Contents', 'MacOS'), { recursive: true })
  const app = path.join(browser, 'Playwright.app', 'Contents', 'MacOS', 'Playwright')
  // Stands in for the browser: prints what the runner hands it.
  if (MAC && CLANG) fs.copyFileSync(macFakeBuild().browser, app)
  else fs.writeFileSync(app, FAKE_BROWSER_SH, { mode: 0o755 })
  const pwRun = path.join(browser, 'pw_run.sh')
  fs.writeFileSync(pwRun, '#!/bin/sh\n', { mode: 0o755 })
  const core = path.join(dir, 'node_modules', 'playwright-core')
  fs.mkdirSync(path.join(core, 'lib', 'server', 'webkit'), { recursive: true })
  fs.writeFileSync(path.join(core, 'lib', 'server', 'webkit', 'webkit.js'), FAKE_SERVER(pwRun))
  fs.writeFileSync(path.join(dir, 'pw-silence-preload.cjs'), pwSilencePreloadSource())
  const lib = path.join(dir, 'pw-noactivate', `noactivate-${createHash('sha256').update(PW_NOACTIVATE_M).digest('hex').slice(0, 16)}.dylib`)
  if (withLibrary) {
    fs.mkdirSync(path.dirname(lib), { recursive: true })
    if (MAC && CLANG) fs.copyFileSync(macFakeBuild().lib, lib)
    else fs.writeFileSync(lib, 'dylib')
  }
  const preload = require(path.join(dir, 'pw-silence-preload.cjs')) as Preload
  const server = { WebKit: (new Function('module', FAKE_SERVER(pwRun) + '; return module.exports')({}) as { WebKit: ServerWebKit }).WebKit }
  return { dir, browser, app, lib, core, preload, server }
}

describe('a Mac WebKit test browser starts through the no-activation runner', () => {
  itRunsBrowser('every launch of the WebKit browser type gets the runner as its executable', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const s = setup('mac')
    expect(s.preload.quietWebkitServer(s.server)).toBe(true)
    expect(s.preload.quietWebkitServer(s.server), 'once per browser type').toBe(false)
    const prepared = await new s.server.WebKit()._prepareToLaunch({ headless: true })
    expect(prepared.executable).toMatch(new RegExp(`^${s.dir}/pw-noactivate/webkit-[0-9a-f]{16}\\.sh$`))
    expect(prepared.browserArguments).toEqual(['--headless'])
    // The runner starts this build's browser with the library loaded and every argument passed on.
    expect(execFileSync(prepared.executable, ['--headless', '--inspector-pipe'], { encoding: 'utf8' }))
      .toBe(`${s.lib}|${s.browser}|${s.browser}|--headless --inspector-pipe`)
    // No temp file is left behind.
    expect(fs.readdirSync(path.join(s.dir, 'pw-noactivate')).filter((f) => !/\.(dylib|sh)$/.test(f))).toEqual([])
  })

  it('keeps an executable the launch or the config names, and leaves another OS and WALNUT_PW_ACTIVATE=1 alone', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const s = setup('own')
    s.preload.quietWebkitServer(s.server)
    expect((await new s.server.WebKit()._prepareToLaunch({ executablePath: '/own/browser' })).executable).toBe('/own/browser')

    const off = setup('off')
    process.env.WALNUT_PW_ACTIVATE = '1'
    expect(off.preload.quietWebkitServer(off.server)).toBe(false)
    delete process.env.WALNUT_PW_ACTIVATE

    Object.defineProperty(process, 'platform', { value: 'linux' })
    const linux = setup('linux')
    expect(linux.preload.quietWebkitServer(linux.server)).toBe(false)
    expect((await new linux.server.WebKit()._prepareToLaunch({})).executable).toBe(path.join(linux.browser, 'pw_run.sh'))
  })

  itRunsBrowser('a launch through the private pasteboard runner loads the no-activation library too', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const s = setup('pasteboard')
    s.preload.quietWebkitServer(s.server)
    type Amend = (env: Record<string, string>, dir: string, persistent: boolean, options: Record<string, unknown>) => Record<string, string>
    const amend = (new s.server.WebKit() as unknown as { amendEnvironment: Amend }).amendEnvironment.bind(new s.server.WebKit())
    const runner = path.join(ROOT, 'tests/e2e/browser/pw-pasteboard/run-webkit.sh')
    // The pasteboard library stand-in: a real one on a Mac, where dyld loads it.
    const pb = path.join(s.dir, 'pb.dylib')
    if (MAC && CLANG) fs.copyFileSync(macFakeBuild().lib, pb)
    else fs.writeFileSync(pb, 'dylib')
    const env = amend({ WALNUT_PW_PASTEBOARD_DYLIB: pb, KEEP: '1' }, '/data', false, { executablePath: runner })
    expect(env).toEqual({ WALNUT_PW_PASTEBOARD_DYLIB: `${pb}:${s.lib}`, KEEP: '1', CURL: 'x' })
    // Once only, and nothing for a launch without that runner.
    expect(amend(env, '/data', false, { executablePath: runner }).WALNUT_PW_PASTEBOARD_DYLIB).toBe(`${pb}:${s.lib}`)
    expect(amend({ KEEP: '1' }, '/data', false, {})).toEqual({ KEEP: '1', CURL: 'x' })
    // The runner itself hands both to the browser.
    const out = execFileSync(runner, ['--headless'], { encoding: 'utf8', env: { ...process.env, WALNUT_PW_WEBKIT_RUN: path.join(s.browser, 'pw_run.sh'), WALNUT_PW_PASTEBOARD_DYLIB: env.WALNUT_PW_PASTEBOARD_DYLIB } })
    expect(out.split('|')[0]).toBe(`${pb}:${s.lib}`)
  })

  it('with no library and no tools to build one, the launch goes on as it was, with one warning', async () => {
    if (fs.existsSync('/Library/Developer/CommandLineTools/usr/bin/clang')) return
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = setup('no-tools', false)
    s.preload.quietWebkitServer(s.server)
    for (let i = 0; i < 2; i++) expect((await new s.server.WebKit()._prepareToLaunch({})).executable).toBe(path.join(s.browser, 'pw_run.sh'))
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('may come to the front'))).toHaveLength(1)
  })

  it('worker threads of one process starting browsers at once on a cold cache all get the runner', async () => {
    const s = setup('threads')
    const script = `const { parentPort, workerData } = require('node:worker_threads')
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      const preload = require(workerData.preload)
      const mod = require(workerData.server)
      preload.quietWebkitServer(mod)
      Atomics.wait(new Int32Array(workerData.gate), 0, 0)
      new mod.WebKit()._prepareToLaunch({}).then((p) => parentPort.postMessage(p.executable))`
    const gate = new SharedArrayBuffer(4)
    const data = { preload: path.join(s.dir, 'pw-silence-preload.cjs'), server: path.join(s.core, 'lib', 'server', 'webkit', 'webkit.js'), gate }
    const workers = Array.from({ length: 6 }, () => new Worker(script, { eval: true, workerData: data }))
    const results = workers.map((w) => new Promise<string>((resolve, reject) => { w.once('message', resolve); w.once('error', reject) }))
    await new Promise((r) => setTimeout(r, 300))
    Atomics.store(new Int32Array(gate), 0, 1)
    Atomics.notify(new Int32Array(gate), 0)
    const got = await Promise.all(results)
    await Promise.all(workers.map((w) => w.terminate()))
    expect(new Set(got).size).toBe(1)
    expect(got[0]).toMatch(/pw-noactivate[\\/]webkit-[0-9a-f]{16}\.sh$/)
  }, 30_000)

  it('the library makes the app background-only and drops its own requests to activate', () => {
    expect(PW_NOACTIVATE_M).toMatch(/NSApplicationActivationPolicyProhibited/)
    for (const sel of ['setActivationPolicy:', 'activateIgnoringOtherApps:', '@"activate"']) expect(PW_NOACTIVATE_M).toContain(sel)
    expect(PW_NOACTIVATE_M).toMatch(/__attribute__\(\(constructor\)\)/)
  })
})

describe('every way a Playwright run starts goes through it', () => {
  it('any load of the WebKit browser type file is caught, in node_modules or Bun\'s cache', async () => {
    const s = setup('loaded')
    expect(s.preload.isWebkitServer(path.join(s.core, 'lib', 'server', 'webkit', 'webkit.js'))).toBe(true)
    expect(s.preload.isWebkitServer('/h/.bun/install/cache/playwright-core@1.58.2@@@1/lib/server/webkit/webkit.js')).toBe(true)
    expect(s.preload.isWebkitServer('/x/node_modules/playwright-core/lib/server/chromium/chromium.js')).toBe(false)
    // From a library's root (the preload's own index.js hook, and the repo silencer).
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    // Loading the file patches it already (the preload's hook), so the call itself may find it done.
    s.preload.quietWebkit(s.core)
    const mod = require(path.join(s.core, 'lib', 'server', 'webkit', 'webkit.js')) as { WebKit: ServerWebKit }
    expect((await new mod.WebKit()._prepareToLaunch({})).executable).toMatch(/webkit-[0-9a-f]{16}\.sh$/)
  })
  it('the preload patches it for every Playwright library and every load of the file, beside the silencer', () => {
    const src = pwSilencePreloadSource()
    expect(src).toMatch(/if \(isPlaywrightCore\(filename\)\) \{ const root = [^;]+; install\(module\.exports\); holdBrowsers\(root\); quietWebkit\(root\)/)
    expect(src).toContain('else if (isWebkitServer(filename)) quietWebkitServer(module.exports);')
  })
  it('the repo silencer every Playwright config imports calls it, even when a runner\'s older preload silenced the pages first', () => {
    // 2026-11-09: a Mac run's preload came from the Mac's main; it set the silenced flag, and a call
    // inside the flag's block never ran.
    const src = fs.readFileSync(path.join(ROOT, 'tests/e2e/browser/pw-silence.ts'), 'utf8')
    const flagBlockEnd = src.indexOf('\n}\n', src.indexOf('if (!g[FLAG])'))
    expect(flagBlockEnd).toBeGreaterThan(0)
    expect(src.indexOf(".quietWebkit(path.dirname(req.resolve('playwright-core')))")).toBeGreaterThan(flagBlockEnd)
  })
})
