/**
 * A Walnut Demo server never serves the person's own ~/.ssh through its file routes, whether
 * "Use my SSH hosts" is on or not (2026-11-12 review: the secret list was read only in cloud
 * mode, so a Demo page or a Demo session could fetch a private key). A plain Walnut is unchanged.
 *
 * The homes are temp dirs; no real ~/.ssh is read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-demo-ssh-files-')))
const passwdHome = path.join(base, 'account')
vi.mock('../../../src/lib/account.js', async (orig) => ({
  ...(await orig<object>()),
  accountInfo: () => ({ username: 'p', homedir: passwdHome, shell: '', uid: 1, gid: 1 }),
}))

const { assertPathAllowed } = await import('../../../src/web/routes/file-content.js')
const { setAccountSsh } = await import('../../../src/lib/ssh-home.js')

const demoHome = path.join(base, 'demo-home')
const key = path.join(passwdHome, '.ssh', 'id_ed25519')
const link = path.join(base, 'notes', 'key-link')

beforeEach(() => {
  fs.mkdirSync(path.join(demoHome, '.ssh'), { recursive: true })
  fs.mkdirSync(path.join(passwdHome, '.ssh'), { recursive: true })
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.writeFileSync(key, 'not a real key')
  fs.writeFileSync(path.join(base, 'notes', 'plain.md'), 'hello')
  if (!fs.existsSync(link)) fs.symlinkSync(key, link)
  vi.stubEnv('HOME', demoHome)
})

afterEach(() => {
  setAccountSsh(null)
  vi.unstubAllEnvs()
})

const status = (p: string, intent: 'read' | 'write' = 'read'): number => {
  try { assertPathAllowed(p, undefined, intent); return 200 } catch (err) { return (err as { statusCode?: number }).statusCode ?? 500 }
}

describe('a Demo server refuses the person\'s ~/.ssh in its file routes', () => {
  it('refuses the account\'s and the Demo HOME\'s .ssh, a link into it, and a write there, flag off or on', () => {
    vi.stubEnv('WALNUT_DEMO_ROOT', path.join(base, 'demo-root'))
    vi.stubEnv('WALNUT_DEMO_GENERATION', 'g1')
    for (const flagOn of [false, true]) {
      setAccountSsh(flagOn ? { home: passwdHome, agentSock: undefined } : null)
      expect(status(key)).toBe(403)
      expect(status(path.join(passwdHome, '.ssh'))).toBe(403)
      expect(status(path.join(demoHome, '.ssh', 'config'))).toBe(403)
      expect(status(link)).toBe(403)
      expect(status(path.join(passwdHome, '.ssh', 'new-file'), 'write')).toBe(403)
      // Anything else still opens.
      expect(status(path.join(base, 'notes', 'plain.md'))).toBe(200)
    }
  })

  it('leaves a plain Walnut as it was', () => {
    expect(status(key)).toBe(200)
    expect(status(link)).toBe(200)
  })
})
