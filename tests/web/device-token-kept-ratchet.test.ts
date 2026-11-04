/**
 * Every page that signs in with the device token in page storage also keeps it
 * where Safari's 7-day rules cannot reach (2026-11-04, the user: "if cookie is
 * cleared need another code"; "how long will cookie usually last"). Safari
 * removes an unopened site's localStorage after 7 days and keeps a cookie a
 * script wrote 7 days at most; the server's HttpOnly cookie
 * (routes/browser-session.ts) stays 400 days and is renewed at every open.
 *
 * The class: a source file that reads `walnut.deviceToken`. Each one is listed
 * here as a page that boots on it (and must renew the cookie and restore from
 * it) or as code that runs inside the console after its sign-in gate (which did
 * both). A new reader fails until it is listed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const KEY = 'walnut.deviceToken'
const ROUTE = '/api/devices/browser-session'

/** Pages that read the token at their own start. */
const BOOT_PAGES: Record<string, string> = {
  'web/src/api/device-token.ts': 'the web console\'s token store (its sign-in gate, sign-in-gate.ts, restores through it)',
  'src/host-server/alone-page.ts': 'the plain host server\'s alone page, its own script',
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
    for (const file of Object.keys(BOOT_PAGES)) {
      expect(fs.readFileSync(path.join(ROOT, file), 'utf8'), file).toContain(ROUTE)
    }
    expect(fs.readFileSync(path.join(ROOT, 'web/src/api/sign-in-gate.ts'), 'utf8')).toMatch(/restoreDeviceToken\(/)
  })

  it('the console renews the server cookie at every open, with its token, saying whether the page is https', async () => {
    vi.resetModules()
    const calls: Array<[string, RequestInit | undefined]> = []
    vi.stubGlobal('window', { location: { protocol: 'https:' } })
    vi.stubGlobal('localStorage', { getItem: () => 'tok-1', setItem: () => {}, removeItem: () => {} })
    vi.stubGlobal('document', { cookie: '' })
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => { calls.push([url, init]); return new Response(null, { status: 204 }) })
    const { syncDeviceCookie } = await import('../../web/src/api/device-token')
    syncDeviceCookie()
    expect(calls.map((c) => c[0])).toEqual([`${ROUTE}?secure=1`])
    expect(new Headers(calls[0]![1]!.headers).get('authorization')).toBe('Bearer tok-1')
  })
})
