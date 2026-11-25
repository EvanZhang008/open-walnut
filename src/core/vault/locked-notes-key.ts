/**
 * The key of locked notes (docs/reference/locked-notes.md): 32 random bytes kept as one item of the
 * Passwords vault, a secure note titled "Walnut locked notes key" with the key in a hidden field.
 *
 * An item, not a side file, on purpose: every rekey of the vault (a new master password, a recovery,
 * a new recovery kit, the machine key turned off) rewraps every item key, in this Walnut and in every
 * older one, so the key never ends up sealed under a vault key nobody has; it is in the daily
 * backups of vault.json, the phone's copy and an export; and the person can see it exists. Agents
 * never get it (agent access never, sensitive), and the vault refuses to change, trash or delete it
 * (items.ts), since every locked note would then be unreadable.
 *
 * Needs the vault open (state.ts requireOpen): the person's unlock, or the machine key.
 */
import { fromB64, randomBytes, toB64 } from './crypto.js'
import { VaultError, requireOpen } from './state.js'
import type { VaultItem, VaultItemInput } from './types.js'

export const LOCKED_NOTES_KEY_FIELD = 'walnut-locked-notes-key'
export const LOCKED_NOTES_KEY_TITLE = 'Walnut locked notes key'

/** Is this the item that holds the locked-notes key? */
export function isLockedNotesKeyItem(it: Pick<VaultItem, 'fields'> | null | undefined): boolean {
  return !!it?.fields?.some((f) => f.name === LOCKED_NOTES_KEY_FIELD)
}

/** The key as the item keeps it (base64), or undefined. */
export function lockedNotesKeyValue(it: Pick<VaultItem, 'fields'>): string | undefined {
  return it.fields?.find((f) => f.name === LOCKED_NOTES_KEY_FIELD)?.value
}

function keyOf(it: VaultItem): Uint8Array | null {
  const raw = lockedNotesKeyValue(it)
  if (!raw) return null
  try {
    const key = fromB64(raw)
    return key.length === 32 ? key : null
  } catch { return null }
}

export interface LockedNotesKey { itemId: string; key: Uint8Array }

/**
 * The key a locked note names (`itemId`), or with none named the vault's own (the oldest key item:
 * one vault has one, but two Walnuts that each made one before a sync are both read). Null when it
 * is not there.
 */
export async function findLockedNotesKey(itemId?: string): Promise<LockedNotesKey | null> {
  const { items } = await requireOpen()
  if (itemId) {
    const it = items.get(itemId)
    const key = it && isLockedNotesKeyItem(it) ? keyOf(it) : null
    return key ? { itemId, key } : null
  }
  const all = [...items.values()].filter(isLockedNotesKeyItem).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  for (const it of all) {
    const key = keyOf(it)
    if (key) return { itemId: it.id, key }
  }
  return null
}

let making: Promise<LockedNotesKey> | null = null

/** The vault's locked-notes key, made the first time a note is locked. One making at a time. */
export async function lockedNotesKeyForNewLock(): Promise<LockedNotesKey> {
  const have = await findLockedNotesKey()
  if (have) return have
  if (!making) {
    making = (async () => {
      const again = await findLockedNotesKey()
      if (again) return again
      const { createItems } = await import('./items.js')
      const input: VaultItemInput = {
        type: 'note',
        title: LOCKED_NOTES_KEY_TITLE,
        notes: 'Walnut opens your locked notes with this key. Deleting or changing it makes every locked note unreadable, so Walnut keeps it as it is.',
        fields: [{ name: LOCKED_NOTES_KEY_FIELD, value: toB64(randomBytes(32)), hidden: true }],
        agentAccess: 'never',
        sensitive: true,
        tags: ['walnut'],
      }
      const [made] = await createItems([input])
      const key = keyOf(made)
      if (!key) throw new VaultError('The locked notes key could not be made', 500, 'locked_notes_key')
      return { itemId: made.id, key }
    })().finally(() => { making = null })
  }
  return making
}
