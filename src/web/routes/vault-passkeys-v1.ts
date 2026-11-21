/**
 * Passkeys in the browser (docs/reference/passwords.md, "Passkeys in the browser"): the browser
 * extension asks which passkeys a page may use, and makes or signs with one only after the
 * person's yes for that one request (core/vault/passkey-approval.ts).
 *
 *   POST   /api/v1/vault/passkeys/match              { origin, rpId?, allow? } → { passkeys }           (session, quiet)
 *   POST   /api/v1/vault/passkeys/begin              { op: create|get, request } → { id, challenge, expiresAt, summary } (session)
 *   POST   /api/v1/vault/passkeys/approve            { id, assertion } | { id, passwordKey | password } → the authenticator's answer (session)
 *   POST   /api/v1/vault/passkeys/cancel             { id } → { ok }                                    (session)
 *   GET    /api/v1/vault/passkeys/confirm-keys       → { keys }                                         (session)
 *   POST   /api/v1/vault/passkeys/confirm-keys/begin → { id, challenge, userId }                        (session)
 *   POST   /api/v1/vault/passkeys/confirm-keys       { enrollId, credentialId, publicKey, clientDataJSON, authenticatorData, name?, passwordKey | password } → { key } (session)
 *   DELETE /api/v1/vault/passkeys/confirm-keys/:id   → { ok }                                           (session)
 *
 * Same gate as every vault route (a person only, the Mac's own vault, never a test run). The
 * private key of a passkey never leaves the server: an answer carries signatures and public keys.
 */
import { Router, type Request } from 'express'
import { SENT, attempt, gate, header, needSession, passwordKeyOf, run, store } from './vault-v1.js'

export const vaultPasskeysV1Router = Router()

const SESSION = 'x-walnut-vault-session'
const tokenOf = (req: Request) => header(req, SESSION)
const body = (req: Request) => (req.body ?? {}) as Record<string, unknown>

/** The master password again, checked as an export checks it (slowed after wrong tries). */
async function passwordAgain(req: Request, res: Parameters<typeof attempt>[0]): Promise<boolean> {
  const st = await store()
  const status = await st.vaultStatus()
  return !!(await attempt(res, async () => st.revealSecretKey(await passwordKeyOf(req, body(req), status.kdf))))
}

vaultPasskeysV1Router.post('/vault/passkeys/match', async (req, res, next) => {
  // Looked up as the person browses (a site asking for a passkey): quiet, like the logins of a page.
  if (!gate(req, res) || !(await needSession(req, res, false))) return
  await run(res, next, async () => {
    const b = body(req)
    const { matchPasskeys } = await import('../../core/vault/passkey-store.js')
    return { passkeys: await matchPasskeys({ origin: b.origin, rpId: b.rpId, allow: b.allow }) }
  })
})

vaultPasskeysV1Router.post('/vault/passkeys/begin', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => {
    const { beginApproval } = await import('../../core/vault/passkey-approval.js')
    return beginApproval(body(req).op, body(req).request, tokenOf(req))
  })
})

vaultPasskeysV1Router.post('/vault/passkeys/approve', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => {
    const { approve, pendingApproval } = await import('../../core/vault/passkey-approval.js')
    const b = body(req)
    if (b.assertion && typeof b.assertion === 'object') {
      return approve(b.id, tokenOf(req), { kind: 'key', assertion: b.assertion as never })
    }
    // A password yes: the request must still be open before the password is checked (a wrong id
    // never counts as a wrong password), and approve takes it once the check passed.
    pendingApproval(b.id, tokenOf(req))
    if (!(await passwordAgain(req, res))) return SENT
    return approve(b.id, tokenOf(req), { kind: 'password' })
  })
})

vaultPasskeysV1Router.post('/vault/passkeys/cancel', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => {
    const { cancelApproval } = await import('../../core/vault/passkey-approval.js')
    cancelApproval(body(req).id, tokenOf(req))
    return { ok: true }
  })
})

vaultPasskeysV1Router.get('/vault/passkeys/confirm-keys', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res, false))) return
  await run(res, next, async () => {
    const { listConfirmKeys } = await import('../../core/vault/passkey-confirm-keys.js')
    return { keys: await listConfirmKeys() }
  })
})

vaultPasskeysV1Router.post('/vault/passkeys/confirm-keys/begin', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => {
    const { beginEnroll } = await import('../../core/vault/passkey-confirm-keys.js')
    return beginEnroll()
  })
})

vaultPasskeysV1Router.post('/vault/passkeys/confirm-keys', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => {
    // A key that says yes for the person is added only with the master password.
    if (!(await passwordAgain(req, res))) return SENT
    const { enrollConfirmKey } = await import('../../core/vault/passkey-confirm-keys.js')
    const b = body(req)
    return { key: await enrollConfirmKey({ enrollId: b.enrollId, credentialId: b.credentialId, publicKey: b.publicKey, clientDataJSON: b.clientDataJSON, authenticatorData: b.authenticatorData, name: b.name }) }
  })
})

vaultPasskeysV1Router.delete('/vault/passkeys/confirm-keys/:id', async (req, res, next) => {
  if (!gate(req, res) || !(await needSession(req, res))) return
  await run(res, next, async () => {
    const { removeConfirmKey } = await import('../../core/vault/passkey-confirm-keys.js')
    return { ok: await removeConfirmKey(String(req.params.id ?? '')) }
  })
})
