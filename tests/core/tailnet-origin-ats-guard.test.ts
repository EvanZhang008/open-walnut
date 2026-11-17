/**
 * Guard: the tailnet origin a phone is handed must be one the iPhone app may open.
 *
 * iOS App Transport Security refuses plain http to a 100.64/10 literal (it is not
 * "local" to NSAllowsLocalNetworking), so a QR or route carrying
 * http://100.x.y.z:PORT fails on a real phone with "requires the use of a secure
 * connection" (2026-11-17, the first real-iPhone tailnet scan). The server builds
 * every tailnet origin through tailnetOrigin() (pairing-targets.ts), which prefers
 * the MagicDNS *.ts.net name, and the app carries an ATS exception for ts.net.
 *
 * The class: any code that turns detectTailnetAddress() into an origin itself.
 * A new caller fails here; route it through tailnetOrigin() instead.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

describe('tailnet origins reach an iPhone', () => {
  it('only tailnetOrigin() turns the tailnet address into an origin', () => {
    const callers = sourceFiles(path.join(ROOT, 'src'))
      .filter((f) => /\bdetectTailnetAddress\(/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f))
      .sort()
    // tailnet.ts defines it; pairing-targets.ts calls it only inside tailnetOrigin().
    expect(callers).toEqual(['src/core/pairing-targets.ts', 'src/core/tailnet.ts'])
    const pt = fs.readFileSync(path.join(ROOT, 'src/core/pairing-targets.ts'), 'utf8')
    expect(pt.match(/\bdetectTailnetAddress\(/g)?.length).toBe(1)
    const body = pt.slice(pt.indexOf('export async function tailnetOrigin'))
    expect(body.slice(0, body.indexOf('\n}\n'))).toContain('detectTailnetAddress()')
  })

  it('the iOS app allows plain http to *.ts.net in both its plist and its project spec', () => {
    const plist = fs.readFileSync(path.join(ROOT, 'ios-native/Walnut/Support/Info.plist'), 'utf8').replace(/\s+/g, '')
    expect(plist).toContain(
      '<key>ts.net</key><dict><key>NSExceptionAllowsInsecureHTTPLoads</key><true/><key>NSIncludesSubdomains</key><true/></dict>',
    )
    const spec = fs.readFileSync(path.join(ROOT, 'ios-native/project.yml'), 'utf8')
    expect(spec).toMatch(/NSExceptionDomains:\n\s+ts\.net:\n\s+NSIncludesSubdomains: true\n\s+NSExceptionAllowsInsecureHTTPLoads: true/)
  })
})
