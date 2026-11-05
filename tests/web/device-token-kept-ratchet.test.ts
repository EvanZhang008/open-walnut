/**
 * Every page that signs in with the device token in page storage also keeps its
 * sign-in where Safari's 7-day rules cannot reach (2026-11-04, the user: "if
 * cookie is cleared need another code"; "how long will cookie usually last").
 * Safari removes an unopened site's localStorage after 7 days and keeps a cookie
 * a script wrote 7 days at most; a cookie the server set is neither. The console
 * renews from the refresh cookie (routes/browser-sign-in.ts, a year, set again at
 * every renewal); the plain host server's alone page restores a browser from
 * before renewing from its `walnut_signin` cookie (routes/browser-session.ts).
 *
 * The class: a source file that reads `walnut.deviceToken`. Each one is listed
 * here as a page that boots on it (and must ask the server's cookie for it) or
 * as code that runs inside the console after its sign-in gate (which did). A
 * new reader fails until it is listed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const KEY = 'walnut.deviceToken'
/** Pages that read the token at their own start, with the server route each asks for its cookie. */
const BOOT_PAGES: Record<string, { route: string; why: string }> = {
  'web/src/api/device-token.ts': { route: '/api/auth/browser/refresh', why: 'the web console\'s token store (its sign-in gate, sign-in-gate.ts, renews through it)' },
  'src/host-server/alone-page.ts': { route: '/api/devices/browser-session', why: 'the plain host server\'s alone page, its own script' },
}

/**
 * Readers that run inside the console, after its sign-in gate restored the token,
 * and only to tell or name it: one that sends it calls getDeviceToken(), which also
 * holds a token storage refused.
 */
const AFTER_GATE: Record<string, string> = {
  'web/src/utils/crash-report.ts': 'says whether a token is stored, in a crash report',
  'web/src/utils/ui-prefs-sync.ts': 'names the key as one never synced',
}

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      out.push(...sources(rel))
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(rel)
    }
  }
  return out
}

afterEach(() => { vi.unstubAllGlobals() })

describe('the device token is kept past Safari\'s 7-day rules', () => {
  const readers = [...sources('src'), ...sources('web/src')]
    .filter((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').includes(KEY))
    .sort()

  it('every reader of the token is listed: a page that boots on it, or code behind the console\'s gate', () => {
    const listed = new Set([...Object.keys(BOOT_PAGES), ...Object.keys(AFTER_GATE)])
    expect(readers.filter((f) => !listed.has(f))).toEqual([])
    // A listed file that stopped reading it leaves the list too.
    expect([...listed].filter((f) => !readers.includes(f))).toEqual([])
  })

  it('every page that boots on it asks the server for its cookie', () => {
    for (const [file, { route }] of Object.entries(BOOT_PAGES)) {
      expect(fs.readFileSync(path.join(ROOT, file), 'utf8'), file).toContain(route)
    }
    expect(fs.readFileSync(path.join(ROOT, 'web/src/api/sign-in-gate.ts'), 'utf8')).toMatch(/renewSignIn\(/)
    expect(fs.readFileSync(path.join(ROOT, 'web/src/main.tsx'), 'utf8')).toMatch(/startSignInRenewal\(\)/)
  })

  it('the console renews with a POST that sends the token it holds (a browser from before renewing starts its pair), saying whether the page is https', async () => {
    vi.resetModules()
    const calls: Array<[string, RequestInit | undefined]> = []
    vi.stubGlobal('window', { location: { protocol: 'https:' } })
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === KEY ? 'tok-1' : null), setItem: () => {}, removeItem: () => {} })
    vi.stubGlobal('document', { cookie: '' })
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => { calls.push([url, init]); return new Response(null, { status: 204 }) })
    const { renewSignIn } = await import('../../web/src/api/device-token')
    expect((await renewSignIn()).kind).toBe('unknown')
    expect(calls.map((c) => c[0])).toEqual(['/api/auth/browser/refresh?secure=1'])
    expect(calls[0]![1]!.method).toBe('POST')
    expect(new Headers(calls[0]![1]!.headers).get('authorization')).toBe('Bearer tok-1')
  })
})
