/**
 * Walnut Connect's local port (docs/reference/walnut-connect.md, "What keeps strangers out"):
 * the app sends its device token to http://127.0.0.1:<port> only while its own library holds
 * that port, since another app could take a port the app is not listening on.
 *
 * Every way the app loads a URL with its token must pass that check:
 *  - URLSession: every session's configuration goes through DemoMode.configured, which puts
 *    WalnutConnectGuard first; no background session (it runs outside the app process).
 *  - Loads outside URLSession (AVPlayer with the token header, a web view's request) ask
 *    WalnutConnect.shared.maySend(to:) just before.
 * A new load of either kind fails here until it does the same.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const app = join(import.meta.dirname, '../../ios-native/Walnut')

function swiftFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...swiftFiles(p))
    else if (name.endsWith('.swift')) out.push(p)
  }
  return out
}

const files = swiftFiles(app).map((p) => ({ file: relative(app, p), lines: readFileSync(p, 'utf8').split('\n') }))
const code = (line: string) => line.replace(/\/\/.*$/, '')

/** Each line matching `re` (comments left out), as file:line. */
function hits(re: RegExp): Array<{ at: string; file: string; line: number; text: string }> {
  const out: Array<{ at: string; file: string; line: number; text: string }> = []
  for (const { file, lines } of files) {
    lines.forEach((text, i) => { if (re.test(code(text))) out.push({ at: `${file}:${i + 1}`, file, line: i, text }) })
  }
  return out
}

/** Does `maySend(to:` appear within the `window` lines before this one, in the same file? */
function gated(file: string, line: number, window = 12): boolean {
  const lines = files.find((f) => f.file === file)!.lines
  return lines.slice(Math.max(0, line - window), line + 1).some((l) => /WalnutConnect\.shared\.maySend\(to:/.test(code(l)))
}

describe('the token reaches the Walnut Connect port only while the app holds it', () => {
  it('the guard runs first in every URLSession configuration, and globally', () => {
    const demo = files.find((f) => f.file === 'Demo/DemoMode.swift')!.lines.join('\n')
    expect(demo).toContain('classes.insert(WalnutConnectGuard.self, at: 1)')
    expect(demo).toContain('config.protocolClasses = classes')
    expect(demo).toContain('URLProtocol.registerClass(WalnutConnectGuard.self)')
    const guardSrc = files.find((f) => f.file === 'Core/WalnutConnectGuard.swift')!.lines.join('\n')
    expect(guardSrc).toContain('!connect.holds(url: request.url)')
    // Only 127.0.0.1 is held: localhost and [::1] name the port on an address never listened on.
    const lib = files.find((f) => f.file === 'Core/WalnutConnect.swift')!.lines.join('\n')
    expect(lib).toMatch(/func holds\(url: URL\?\) -> Bool \{\s*guard let url, url\.host == "127\.0\.0\.1"/)
  })

  it('every URLSession is built from DemoMode.configured, and none runs in the background', () => {
    const made = hits(/URLSession\(\s*configuration:/)
    expect(made.length).toBeGreaterThan(3)
    const bare = made.filter((h) => !h.text.includes('DemoMode.configured('))
    expect(bare.map((h) => h.at)).toEqual([])
    expect(hits(/URLSessionConfiguration\.background/).map((h) => h.at)).toEqual([])
  })

  it('the HTML preview sets no device cookie on a Walnut Connect address (cookies ignore ports)', () => {
    const preview = files.find((f) => f.file === 'Views/HTMLFilePreview.swift')!.lines.join('\n')
    const fn = preview.slice(preview.indexOf('static func deviceCookie('))
    expect(fn.slice(0, fn.indexOf('HTTPCookie(properties'))).toContain('if WalnutConnect.shared.isConnectURL(url) { return nil }')
    // No other cookie with the token is set anywhere in the app.
    expect(hits(/\.name:\s*"walnut_device"/).map((h) => h.file)).toEqual(['Views/HTMLFilePreview.swift'])
  })

  it('AVPlayer loads that carry the token ask maySend first', () => {
    const withToken = hits(/AVURLAssetHTTPHeaderFieldsKey/)
    expect(withToken.length).toBeGreaterThan(0)
    expect(withToken.filter((h) => !gated(h.file, h.line)).map((h) => h.at)).toEqual([])
  })

  it('a web view loads a request only through walnutLoad, which asks maySend first', () => {
    // A request load (not an HTML string or a local file) anywhere else skips the check.
    const loads = hits(/(\bwebView|\bweb|\bview|\bself)?\.?\bload\(\s*(request|URLRequest|req)\b/)
      .filter((h) => files.find((f) => f.file === h.file)!.lines.some((l) => /^import WebKit/.test(l)))
    expect(loads.length).toBeGreaterThan(0)
    expect(loads.filter((h) => h.file !== 'Demo/DemoChrome.swift' || !gated(h.file, h.line)).map((h) => h.at)).toEqual([])
    // And walnutLoad is how the HTML preview loads a server file.
    expect(hits(/\.walnutLoad\(/).length).toBeGreaterThan(0)
  })
})
