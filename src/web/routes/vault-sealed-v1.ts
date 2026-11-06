/**
 * The vault's ciphertext for a person's own device that opens it itself (the iPhone app and its
 * AutoFill extension, docs/reference/passwords.md "iPhone"). Nothing here decrypts: the answer is
 * vault.json as it is on disk, so the server and the cloud companion that carries it see only
 * ciphertext, and the device needs the master password AND the Secret Key to read any of it.
 *
 *   GET  /api/v1/vault/sealed[?after=<id>]   → { vault: header, items: { <id>: tag }, next? }
 *   POST /api/v1/vault/sealed/items { ids }  → { items: { <id>: StoredItem }, more }
 *
 * The header is what opening needs (format, version, id, rev, kdf, aukSalt, the password wrap);
 * the machine and recovery wraps stay here, since no device can use them. A tag names one sealed
 * state of an item (a hash of its two nonces, both fresh on every seal, a rekey included), so a
 * device fetches only what changed. Both answers stay under the companion's forward limit
 * (v1-forward/policy.ts MAX_FORWARD_RESPONSE_BYTES), paged by `next` and `more`.
 *
 * Who: the same person gate as every vault route (gate in vault-v1.ts): no session caller, no CLI
 * automation mark, no test run, the leader only. These two are the only vault routes the companion
 * forwards, because they carry nothing it could read.
 */
import crypto from 'node:crypto'
import { Router } from 'express'
import { gate } from './vault-v1.js'

export const vaultSealedV1Router = Router()

/** Under the companion's 256 KB forward limit, with room for the JSON around it. */
export const SEALED_PAGE_BYTES = 200 * 1024
/** Index entries per page: an id (36) and a tag (16) are about 60 bytes, so 3000 is ~180 KB. */
export const SEALED_INDEX_PAGE = 3000
export const SEALED_IDS_MAX = 5000

/** One sealed state of an item: changes whenever the item or its key is sealed again. */
export function sealedTag(s: { key: { iv: string }; data: { iv: string } }): string {
  return crypto.createHash('sha256').update(`${s.key.iv}.${s.data.iv}`).digest('base64url').slice(0, 16)
}

async function stateMod() {
  return import('../../core/vault/state.js')
}

vaultSealedV1Router.get('/vault/sealed', async (req, res, next) => {
  if (!gate(req, res)) return
  try {
    const st = await stateMod()
    const f = await st.loadFile()
    if (!f) { res.status(409).json({ error: 'No vault yet: set Passwords up on your Mac first.', code: 'vault_not_set_up' }); return }
    const after = typeof req.query.after === 'string' ? req.query.after : ''
    const ids = Object.keys(f.items).sort()
    const start = after ? ids.findIndex((id) => id > after) : 0
    const page = start < 0 ? [] : ids.slice(start, start + SEALED_INDEX_PAGE)
    const items: Record<string, string> = {}
    for (const id of page) items[id] = sealedTag(f.items[id])
    const last = page[page.length - 1]
    const more = start >= 0 && start + page.length < ids.length
    res.json({
      vault: {
        format: f.format, version: f.version, id: f.id, rev: f.rev, updatedAt: f.updatedAt,
        kdf: f.kdf, aukSalt: f.aukSalt, wrap: f.wraps.password, count: ids.length,
      },
      items,
      ...(more && last ? { next: last } : {}),
    })
  } catch (err) {
    const st = await stateMod()
    if (err instanceof st.VaultError) { res.status(err.status).json({ error: err.message, code: err.code }); return }
    next(err)
  }
})

vaultSealedV1Router.post('/vault/sealed/items', async (req, res, next) => {
  if (!gate(req, res)) return
  try {
    const raw = (req.body as { ids?: unknown } | undefined)?.ids
    if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string') || raw.length > SEALED_IDS_MAX) {
      res.status(400).json({ error: `ids must be a list of at most ${SEALED_IDS_MAX} item ids`, code: 'bad_ids' })
      return
    }
    const st = await stateMod()
    const f = await st.loadFile()
    if (!f) { res.status(409).json({ error: 'No vault yet: set Passwords up on your Mac first.', code: 'vault_not_set_up' }); return }
    const items: Record<string, unknown> = {}
    const missing: string[] = []
    let bytes = 64
    let more = false
    for (const id of [...new Set(raw as string[])]) {
      const s = Object.prototype.hasOwnProperty.call(f.items, id) ? f.items[id] : undefined
      if (!s) { missing.push(id); continue }
      const size = JSON.stringify(s).length + id.length + 8
      // Always at least one item, so an item larger than a page still comes across.
      if (Object.keys(items).length > 0 && bytes + size > SEALED_PAGE_BYTES) { more = true; continue }
      items[id] = { key: s.key, data: s.data, updatedAt: s.updatedAt, tag: sealedTag(s) }
      bytes += size
    }
    res.json({ vaultId: f.id, rev: f.rev, items, missing, more })
  } catch (err) {
    const st = await stateMod()
    if (err instanceof st.VaultError) { res.status(err.status).json({ error: err.message, code: err.code }); return }
    next(err)
  }
})
