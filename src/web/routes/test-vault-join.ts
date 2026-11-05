/**
 * POST /api/test/vault-join {device, on?}: the Playwright fixture's switch for which browser
 * extensions share the person's unlock (core/vault/sessions.ts joinSource). Mounted ONLY when
 * WALNUT_TEST_VAULT_JOIN=named on an ephemeral, non-cloud server (joinTestRouteAllowed: the
 * fixture server, tests/e2e/browser/test-server.ts), where the one vault serves specs running
 * side by side and a spec names its own extension so another spec's unlock never unlocks it.
 */
import { Router } from 'express'
import { nameJoinDeviceForTest } from '../../core/vault/sessions.js'

export const testVaultJoinRouter = Router()

testVaultJoinRouter.post('/', (req, res) => {
  const body = (req.body ?? {}) as { device?: unknown; on?: unknown }
  if (typeof body.device !== 'string' || !/^extension-[0-9a-f]+$/.test(body.device)) {
    res.status(400).json({ error: 'device: an extension-<hex> device name' })
    return
  }
  nameJoinDeviceForTest(body.device, body.on !== false)
  res.json({ ok: true })
})
