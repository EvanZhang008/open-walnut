/**
 * Vault items: create, edit, trash, restore, delete, favorite, mark used. Every change goes
 * through `mutate` (state.ts), so a write that fails leaves memory as it was on disk.
 */
import crypto from 'node:crypto'
import { randomBytes, seal, sealJson } from './crypto.js'
import { VaultError, aadItem, aadItemKey, mutate, requireOpen, type VaultFile } from './state.js'
import {
  NOTES_MAX, PASSWORD_HISTORY_MAX, SECRET_MAX, TITLE_MAX, TRASH_DAYS, VAULT_ITEM_TYPES, summarize,
  type VaultItem, type VaultItemInput, type VaultItemSummary,
} from './types.js'
import { normalizeUrl } from './url-match.js'
import { mergePasskeys } from './passkey.js'


function clip(s: unknown, max: number): string | undefined {
  if (typeof s !== 'string') return undefined
  return s.length > max ? s.slice(0, max) : s
}

export function cleanInput(input: VaultItemInput): VaultItemInput {
  if (!input || typeof input !== 'object') throw new VaultError('item must be an object', 400, 'bad_item')
  if (!VAULT_ITEM_TYPES.includes(input.type)) throw new VaultError(`type must be one of ${VAULT_ITEM_TYPES.join(', ')}`, 400, 'bad_item')
  const title = clip(input.title, TITLE_MAX)?.trim()
  if (!title) throw new VaultError('title is required', 400, 'bad_item')
  const out: VaultItemInput = { type: input.type, title }
  const s = (k: 'username' | 'password' | 'totp' | 'envName', max = SECRET_MAX) => {
    const v = clip(input[k], max)
    if (v) out[k] = v
  }
  s('username', 500); s('password'); s('totp', 1000); s('envName', 100)
  if (out.envName && !/^[A-Z_][A-Z0-9_]*$/.test(out.envName)) throw new VaultError('envName is upper case letters, digits and _', 400, 'bad_item')
  const notes = clip(input.notes, NOTES_MAX)
  if (notes) out.notes = notes
  if (Array.isArray(input.urls)) {
    const urls = [...new Set(input.urls.map((u) => normalizeUrl(String(u))).filter(Boolean))].slice(0, 20)
    if (urls.length) out.urls = urls
  }
  if (Array.isArray(input.fields)) {
    out.fields = input.fields.slice(0, 50).filter((f) => f && typeof f.name === 'string' && f.name.trim())
      .map((f) => ({ name: f.name.trim().slice(0, 100), value: String(f.value ?? '').slice(0, SECRET_MAX), ...(f.hidden ? { hidden: true } : {}) }))
    if (!out.fields.length) delete out.fields
  }
  if (input.card && typeof input.card === 'object') {
    const c = input.card
    out.card = Object.fromEntries(Object.entries({ holder: c.holder, number: c.number, expMonth: c.expMonth, expYear: c.expYear, code: c.code, brand: c.brand })
      .map(([k, v]) => [k, clip(v, 100)]).filter(([, v]) => v)) as VaultItem['card']
  }
  if (Array.isArray(input.tags)) {
    const tags = [...new Set(input.tags.map((t) => String(t).trim().slice(0, 50)).filter(Boolean))].slice(0, 20)
    if (tags.length) out.tags = tags
  }
  if (Array.isArray(input.passkeys) && input.passkeys.length) out.passkeys = input.passkeys.slice(0, 50)
  if (input.favorite) out.favorite = true
  if (input.sensitive) out.sensitive = true
  if (input.agentAccess === 'never' || input.agentAccess === 'allow' || input.agentAccess === 'ask') out.agentAccess = input.agentAccess
  return out
}

async function writeItem(f: VaultFile, key: Uint8Array, item: VaultItem): Promise<void> {
  const ik = randomBytes(32)
  f.items[item.id] = {
    key: await seal(key, ik, aadItemKey(f.id, item.id)),
    data: await sealJson(ik, item, aadItem(f.id, item.id)),
    updatedAt: item.updatedAt,
  }
}

function purgeTrash(f: VaultFile, items: Map<string, VaultItem>, now: number): boolean {
  let changed = false
  for (const [id, it] of items) {
    if (it.trashedAt && now - Date.parse(it.trashedAt) > TRASH_DAYS * 86_400_000) {
      items.delete(id)
      delete f.items[id]
      changed = true
    }
  }
  return changed
}

export async function listItems(): Promise<VaultItemSummary[]> {
  const { items } = await requireOpen()
  return [...items.values()].map(summarize).sort((a, b) => a.title.localeCompare(b.title))
}

export async function getItem(id: string): Promise<VaultItem> {
  const { items } = await requireOpen()
  const it = items.get(id)
  if (!it) throw new VaultError('No such item', 404, 'not_found')
  return it
}

/** Every open item (export, security report). Callers never return secrets they were not allowed. */
export async function allItems(): Promise<VaultItem[]> {
  const { items } = await requireOpen()
  return [...items.values()]
}

export async function createItems(inputs: VaultItemInput[]): Promise<VaultItem[]> {
  const clean = inputs.map(cleanInput)
  return mutate(async ({ f, key, items }) => {
    const now = new Date().toISOString()
    const made: VaultItem[] = []
    for (const input of clean) {
      const item: VaultItem = { ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now }
      await writeItem(f, key, item)
      items.set(item.id, item)
      made.push(item)
    }
    purgeTrash(f, items, Date.now())
    return { result: made }
  })
}

export async function updateItem(id: string, input: VaultItemInput, expectedUpdatedAt?: string): Promise<VaultItem> {
  const clean = cleanInput(input)
  return mutate(async ({ f, key, items }) => {
    const prev = items.get(id)
    if (!prev) throw new VaultError('No such item', 404, 'not_found')
    if (expectedUpdatedAt && prev.updatedAt !== expectedUpdatedAt) throw new VaultError('This item changed since you opened it', 409, 'stale_item')
    const now = new Date().toISOString()
    let history = prev.passwordHistory ?? []
    if (prev.password && prev.password !== clean.password) {
      history = [{ password: prev.password, replacedAt: now }, ...history].slice(0, PASSWORD_HISTORY_MAX)
    }
    // A client that does not know passkeys (an older one, an agent) never drops them: only an
    // explicit list removes some. Clients never hold their keys, so each keeps its stored one.
    const passkeys = Array.isArray(input.passkeys) ? mergePasskeys(prev.passkeys, input.passkeys.slice(0, 50)) : prev.passkeys
    const { passkeys: _p, ...rest } = clean
    const item: VaultItem = {
      ...rest, id, createdAt: prev.createdAt, updatedAt: now,
      ...(passkeys?.length ? { passkeys } : {}),
      ...(history.length ? { passwordHistory: history } : {}),
      ...(prev.usedAt ? { usedAt: prev.usedAt } : {}),
      ...(prev.trashedAt ? { trashedAt: prev.trashedAt } : {}),
    }
    await writeItem(f, key, item)
    items.set(id, item)
    return { result: item }
  })
}

/** Change one item in place (null deletes it), under the vault's write lock. */
export async function patchItem(id: string, fn: (it: VaultItem) => VaultItem | null): Promise<VaultItem | null> {
  return mutate(async ({ f, key, items }) => {
    const prev = items.get(id)
    if (!prev) throw new VaultError('No such item', 404, 'not_found')
    const next = fn(prev)
    if (next === null) {
      items.delete(id)
      delete f.items[id]
    } else {
      await writeItem(f, key, next)
      items.set(id, next)
    }
    return { result: next }
  })
}

export async function trashItem(id: string): Promise<VaultItem> {
  return (await patchItem(id, (it) => ({ ...it, trashedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })))!
}

export async function restoreItem(id: string): Promise<VaultItem> {
  return (await patchItem(id, (it) => { const { trashedAt: _t, ...rest } = it; return { ...rest, updatedAt: new Date().toISOString() } }))!
}

/** Delete for good: only from the trash. */
export async function deleteItem(id: string): Promise<void> {
  await patchItem(id, (it) => {
    if (!it.trashedAt) throw new VaultError('Move the item to the trash first', 409, 'not_in_trash')
    return null
  })
}

export async function setFavorite(id: string, favorite: boolean): Promise<VaultItem> {
  return (await patchItem(id, (it) => {
    const { favorite: _f, ...rest } = it
    return { ...rest, ...(favorite ? { favorite: true } : {}), updatedAt: new Date().toISOString() }
  }))!
}

/** Record a fill or copy (no new updatedAt: it is not an edit). */
export async function markUsed(id: string): Promise<void> {
  await patchItem(id, (it) => ({ ...it, usedAt: new Date().toISOString() }))
}
