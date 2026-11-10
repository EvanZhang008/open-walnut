/**
 * Every WebKit test browser on a Mac has a pasteboard of its own (2026-11-10: a paste spec in
 * headless WebKit wrote the Mac's real clipboard and replaced what the person had copied; about 50
 * specs copy, cut or paste). Linux browsers and headless Chromium keep their clipboard in the
 * browser already; Playwright's WebKit on macOS uses the system one.
 *
 * pw-pasteboard/private-pasteboard.m, built once per source and machine with clang, is loaded into
 * the WebKit process and hands it a private named pasteboard whenever it asks for the general one,
 * so copy, cut, paste and the async clipboard API work inside the run and never reach the person.
 * macOS drops DYLD_* variables passing through /bin/bash (Playwright's pw_run.sh), so the browser
 * starts through pw-pasteboard/run-webkit.sh, which names the library at the WebKit binary's exec.
 * The library writes a mark file when it is in place; a launch without it is closed and refused,
 * never run on the person's clipboard. pw-silence.ts wraps every WebKit launch with this.
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pw-pasteboard')
export const PASTEBOARD_SOURCE = path.join(HERE, 'private-pasteboard.m')
export const WEBKIT_RUNNER = path.join(HERE, 'run-webkit.sh')

const cacheDir = () => path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), 'Library', 'Caches'), 'walnut-pw-pasteboard')

/** The built library for this source and CPU, built when missing. Throws with the way to fix it. */
export function pasteboardLibrary(): string {
  const src = fs.readFileSync(PASTEBOARD_SOURCE)
  const out = path.join(cacheDir(), `${crypto.createHash('sha256').update(src).digest('hex').slice(0, 16)}-${process.arch}.dylib`)
  if (fs.existsSync(out)) return out
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const tmp = `${out}.${process.pid}.tmp`
  try {
    execFileSync('clang', ['-dynamiclib', '-fobjc-arc', '-framework', 'AppKit', '-o', tmp, PASTEBOARD_SOURCE], { stdio: ['ignore', 'ignore', 'pipe'] })
    fs.renameSync(tmp, out)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw new Error(`a WebKit test browser on macOS needs a pasteboard of its own, so it never writes your clipboard, and building it failed (${(e as Error).message.split('\n')[0]}). Install the command line tools (xcode-select --install) and run again.`)
  }
  return out
}

export interface WebkitLaunchOptions { executablePath?: string; env?: Record<string, string | number | boolean | undefined> }

/** The launch options that start WebKit through the runner with the private pasteboard. */
export function privatePasteboardOptions<T extends WebkitLaunchOptions>(options: T, webkitRun: string, library = pasteboardLibrary): { options: T; mark: string } {
  const dylib = library()
  const mark = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-pasteboard-')), 'loaded')
  const env = { ...(options.env ?? process.env) } as Record<string, string | number | boolean | undefined>
  env.WALNUT_PW_WEBKIT_RUN = options.executablePath ?? webkitRun
  env.WALNUT_PW_PASTEBOARD_DYLIB = dylib
  env.WALNUT_PW_PASTEBOARD_MARK = mark
  return { options: { ...options, executablePath: WEBKIT_RUNNER, env }, mark }
}

/** Throws (after closing what was launched) unless the library said it is in place. */
export async function requirePrivatePasteboard(mark: string, close: () => Promise<unknown>): Promise<void> {
  const ok = fs.existsSync(mark)
  if (ok) return
  await close().catch(() => {})
  throw new Error('the WebKit test browser started without a pasteboard of its own, so it was closed before any page could write your clipboard (tests/e2e/browser/pw-pasteboard.ts).')
}

/** Set on every WebKit launch function the guard wraps, so a spec can check before it copies. */
export const PASTEBOARD_GUARDED = Symbol.for('walnut.pwPasteboardGuarded')

interface Closable { close(): Promise<unknown> }
interface WebkitType {
  executablePath(): string
  launch(options?: WebkitLaunchOptions): Promise<Closable>
  launchPersistentContext(dir: string, options?: WebkitLaunchOptions): Promise<Closable>
  launchServer(options?: WebkitLaunchOptions): Promise<Closable>
}

/**
 * Wraps every way to start WebKit on a Mac. Elsewhere it changes nothing. `defaults` reads the
 * project's launch options, which the client merges under each call's own: their env and
 * executablePath are kept, since the wrapper's explicit ones would replace them.
 */
export function guardWebkitPasteboard(webkit: WebkitType, platform = process.platform, library = pasteboardLibrary, defaults: () => WebkitLaunchOptions | undefined = () => undefined): void {
  if (platform !== 'darwin') return
  const start = async <R extends Closable>(options: WebkitLaunchOptions, go: (o: WebkitLaunchOptions) => Promise<R>): Promise<R> => {
    const d = defaults() ?? {}
    const merged = { ...options, env: options.env ?? d.env, executablePath: options.executablePath ?? d.executablePath }
    const p = privatePasteboardOptions(merged, webkit.executablePath(), library)
    try {
      const b = await go(p.options)
      await requirePrivatePasteboard(p.mark, () => b.close())
      return b
    } finally {
      fs.rmSync(path.dirname(p.mark), { recursive: true, force: true })
    }
  }
  const launch = webkit.launch.bind(webkit)
  const persistent = webkit.launchPersistentContext.bind(webkit)
  const server = webkit.launchServer.bind(webkit)
  webkit.launch = (options = {}) => start(options, launch)
  webkit.launchPersistentContext = (dir, options = {}) => start(options, (o) => persistent(dir, o))
  webkit.launchServer = (options = {}) => start(options, server)
  for (const f of [webkit.launch, webkit.launchPersistentContext, webkit.launchServer]) (f as unknown as Record<symbol, boolean>)[PASTEBOARD_GUARDED] = true
}
