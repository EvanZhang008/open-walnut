/**
 * Every refusal POST /vault/unlock can answer with has words in the unlock clients, and every
 * unlock form goes through the retry and those words (src/core/vault/unlock-retry.ts).
 *
 * 2026-11-06: the extension's lock screens said "Too many tries. Wait N s." only for
 * `too_many_attempts`, a code the server never sends (it sends `unlock_slowed`), and every client
 * showed "Another unlock is being checked" under a correct password instead of trying again. The
 * codes are read from the route's own code and the functions it calls, so a new refusal fails here
 * until UNLOCK_REFUSALS says what a person reads for it.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { UNLOCK_REFUSALS } from '../../src/core/vault/unlock-retry'

const ROOT = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

/** The body of top-level function `name` in `src` (from its line to the closing brace at column 0). */
function fnBody(src: string, name: string): string {
  const m = new RegExp(`^(?:export )?(?:async )?function ${name}\\b[^\\n]*$`, 'm').exec(src)
  if (!m) throw new Error(`no function ${name}`)
  const end = src.indexOf('\n}', m.index)
  return src.slice(m.index, end + 2)
}

/** The refusal codes written in `code`: `code: 'x'` answers and `new VaultError(..., 400, 'x')` throws. */
function codesIn(code: string): string[] {
  const out = new Set<string>()
  for (const m of code.matchAll(/\bcode: '([a-z_]+)'/g)) out.add(m[1])
  for (const m of code.matchAll(/,\s*\d{3},\s*'([a-z_]+)'\s*\)/g)) out.add(m[1])
  return [...out]
}

const routes = read('src/web/routes/vault-v1.ts')
const unlockStart = routes.indexOf("vaultV1Router.post('/vault/unlock'")
const unlockHandler = routes.slice(unlockStart, routes.indexOf('\n})', unlockStart) + 3)
const store = read('src/core/vault/store.ts')
const sessions = read('src/core/vault/sessions.ts')

/** What the unlock route can answer: its gate, its handler, the check brake, the key it reads and the store's unlock. */
const ROUTE_CODES = [...new Set([
  ...codesIn(fnBody(routes, 'gate')),
  ...codesIn(unlockHandler),
  ...codesIn(fnBody(routes, 'attempt')),
  ...codesIn(fnBody(routes, 'passwordKeyOf')),
  ...codesIn(fnBody(sessions, 'beginAttempt')),
  ...['unlockVault', 'checkPassword', 'pwKeyBytes', 'checkKdf'].flatMap((f) => codesIn(fnBody(store, f))),
])].sort()

describe('unlock refusals', () => {
  it('reads the codes from the route (the matchers still match)', () => {
    expect(unlockStart).toBeGreaterThan(0)
    expect(ROUTE_CODES).toEqual(expect.arrayContaining(['unlock_busy', 'unlock_slowed', 'wrong_password', 'kdf_changed', 'secret_key_needed', 'human_only']))
  })

  it('every code the unlock route can send has words in the unlock clients', () => {
    const missing = ROUTE_CODES.filter((c) => !(c in UNLOCK_REFUSALS))
    expect(missing, 'add these to UNLOCK_REFUSALS in src/core/vault/unlock-retry.ts').toEqual([])
  })

  it('the brake reads "Too many tries", by the server\'s code', () => {
    expect(UNLOCK_REFUSALS.unlock_slowed?.({ waitMs: 5_000 })).toBe('Too many tries. Wait 5 s.')
  })

  it('the extension sends an unlock only through unlock-send.ts, and its lock screens use its words', () => {
    const dir = 'packages/browser-extension/src'
    const files = fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.ts'))
    const senders = files.filter((f) => /type: 'unlock'/.test(read(`${dir}/${f}`)))
    expect(senders).toEqual(['unlock-send.ts'])
    const route = files.filter((f) => /['`]\/vault\/unlock['`]/.test(read(`${dir}/${f}`)))
    expect(route).toEqual(['walnut-api.ts'])
    for (const f of ['popup.ts', 'key-pop.ts']) {
      const src = read(`${dir}/${f}`)
      expect(src, f).toMatch(/sendUnlock\([^\n]*onWait/)
      expect(src, f).toMatch(/unlockRefusal\(r\)/)
    }
    // Its own refusal words live in one place: no lock screen reads a code for them itself.
    expect(files.filter((f) => f !== 'unlock-send.ts' && /too_many_attempts|unlock_slowed|unlock_busy/.test(read(`${dir}/${f}`)))).toEqual([])
  })

  it('the web app unlocks only through vaultApi.unlock, and every form shows Checking and the shared words', () => {
    const webFiles: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
        const p = `${d}/${e.name}`
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name)) webFiles.push(p)
      }
    }
    walk('web/src')
    expect(webFiles.filter((f) => /['`]\/vault\/unlock['`]/.test(read(f)))).toEqual(['web/src/api/vault.ts'])
    const forms = webFiles.filter((f) => /vaultApi\.unlock\(/.test(read(f)))
    expect(forms).toEqual(expect.arrayContaining(['web/src/components/passwords/LockScreens.tsx', 'web/src/components/approvals/ApprovalUnlock.tsx']))
    for (const f of forms) {
      const src = read(f)
      for (const call of src.match(/vaultApi\.unlock\([^\n]*/g) ?? []) expect(call, f).toMatch(/onWait/)
      expect(src, f).toMatch(/unlockRefusalText\(/)
      expect(src, f).toMatch(/'Checking…'/)
    }
  })
})
