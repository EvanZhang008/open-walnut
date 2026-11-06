/**
 * POST /api/test/vault-join {device | browserKey, on?}: the Playwright fixture's switch for which
 * browser extensions and Walnut windows share the person's unlock (core/vault/sessions.ts
 * joinSource). Mounted ONLY when WALNUT_TEST_VAULT_JOIN=named on an ephemeral, non-cloud server
 * (joinTestRouteAllowed: the fixture server, tests/e2e/browser/test-server.ts), where the one vault
 * serves specs running side by side and a spec names its own extension (its device) or window (the
 * browser key in its localStorage) so another spec's unlock never unlocks it.
 */
import { Router } from 'express'
import { nameJoinDeviceForTest } from '../../core/vault/sessions.js'
import { browserKeyShape, windowJoiner } from '../../core/vault/browser-keys.js'

export const testVaultJoinRouter = Router()

testVaultJoinRouter.post('/', (req, res) => {
  const body = (req.body ?? {}) as { device?: unknown; browserKey?: unknown; on?: unknown }
  const joiner = typeof body.device === 'string' && /^extension-[0-9a-f]+$/.test(body.device) ? body.device
    : typeof body.browserKey === 'string' && browserKeyShape(body.browserKey) ? windowJoiner(body.browserKey) : null
  if (!joiner) {
    res.status(400).json({ error: 'device: an extension-<hex> device name, or browserKey: a window\'s browser key' })
    return
  }
  nameJoinDeviceForTest(joiner, body.on !== false)
  res.json({ ok: true })
})
