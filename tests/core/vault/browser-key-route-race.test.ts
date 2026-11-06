/**
 * POST /vault/browser-key asks again, after each wait, whether the extension's session may still hand
 * a key (code review 2026-11-06, D02 round 3): a hand that passed the check, then waited on the side
 * file while a new master password ended every old unlock, answered with a fresh key. The real route
 * and the real sessions; the key store and the server's wiring are stand-ins that hold at the wait.
 */
import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ entered: () => {}, pending: Promise.resolve(), keys: new Set<string>(), asked: [] as boolean[] }))

vi.mock('../../../src/core/server-role.js', () => ({ isFollower: () => false, role: () => 'leader' }))
vi.mock('../../../src/core/test-run.js', () => ({ ambientTestRun: () => undefined }))
vi.mock('../../../src/core/device-auth.js', () => ({ onCredentialsRevoked: () => {} }))
vi.mock('../../../src/core/expose/status.js', () => ({ currentExposeStatus: () => ({}) }))
vi.mock('../../../src/core/config-store.js', () => ({ onConfigWritten: () => {} }))
vi.mock('../../../src/core/vault/session-store.js', () => ({ sessionsRestored: async () => {} }))
vi.mock('../../../src/core/vault/store.js', () => ({ isOpen: () => true, VaultError: class extends Error {} }))
vi.mock('../../../src/core/vault/browser-keys.js', () => ({
  browserKeyShape: (key: unknown) => typeof key === 'string' && key.length === 43,
  knownBrowser: async (key: string | undefined) => { state.entered(); await state.pending; return key && state.keys.has(key) ? `window:${key}` : null },
  touchBrowser: async () => {},
  // The real one asks `stillAllowed` inside the side file's queue (browser-key-revoke-race.test.ts).
  issueBrowserKey: async (_p: unknown, _c: string, _n: number, stillAllowed?: () => boolean) => {
    const ok = !stillAllowed || stillAllowed()
    state.asked.push(ok)
    if (!ok) return null
    const key = 'K'.repeat(43); state.keys.add(key); return key
  },
  windowJoiner: (key: string) => `window:${key}`,
}))

const S = await import('../../../src/core/vault/sessions.js')
const { vaultV1Router } = await import('../../../src/web/routes/vault-v1.js')

type Layer = { route?: { path: string; stack: { handle: (...a: unknown[]) => Promise<void> }[] } }

function hand(token: string, device: string, body: Record<string, unknown> = {}) {
  const layer = (vaultV1Router.stack as Layer[]).find((x) => x.route?.path === '/vault/browser-key')!
  const req = { headers: { host: 'localhost:3456', origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'x-walnut-vault-session': token, 'x-walnut-vault-quiet': '1' }, socket: { localPort: 3456, remoteAddress: '127.0.0.1' }, deviceName: device, body }
  const out: { status: number; body?: unknown } = { status: 200 }
  const res = { headersSent: false, setHeader() {}, status(n: number) { out.status = n; return res }, json(b: unknown) { out.body = b; res.headersSent = true } }
  const done = layer.route!.stack[0].handle(req, res, (err: unknown) => { throw err })
  return { done, out }
}

describe('POST /vault/browser-key across a new master password', () => {
  for (const presented of [undefined, 'K'.repeat(43)]) {
    it(`a hand waiting when every old unlock ended hands nothing (${presented ? 'a known key' : 'a new key'})`, async () => {
      S.resetSessionsForTest()
      state.keys = new Set(presented ? [presented] : [])
      state.asked = []
      const device = 'extension-a1b2c3'
      const token = S.createSession('ext', 15, device, true).token
      let enter!: () => void
      const entered = new Promise<void>((r) => { enter = r })
      let release!: () => void
      state.pending = new Promise<void>((r) => { release = r })
      state.entered = enter
      const h = hand(token, device, presented ? { browserKey: presented } : {})
      await entered
      // A new master password: every old unlock ends, none made before it is shared, the keys go.
      S.endAllSessions()
      S.endJoinsBefore()
      state.keys.clear()
      release()
      await h.done
      expect(h.out.status).toBe(409)
      expect(h.out.body).toMatchObject({ code: 'nothing_to_hand' })
      expect(state.keys.size).toBe(0)
      S.resetSessionsForTest()
    })
  }

  it('with nothing in between, the extension hands a new key', async () => {
    S.resetSessionsForTest()
    state.keys = new Set(); state.pending = Promise.resolve(); state.entered = () => {}
    const device = 'extension-a1b2c3'
    const token = S.createSession('ext', 15, device, true).token
    const h = hand(token, device)
    await h.done
    expect(h.out.status).toBe(200)
    expect(h.out.body).toMatchObject({ known: false })
    S.resetSessionsForTest()
  })
})
