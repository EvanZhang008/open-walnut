/**
 * The locked-notes key and the master password hint, backed up with the data folder
 * (docs/reference/locked-notes.md, "Backup of the key"). The vault lives on this computer only
 * (docs/reference/passwords.md, "Where it lives"), while a locked note's ciphertext goes wherever
 * the data folder syncs: without this file, losing this computer would leave every locked note
 * unreadable. The user's pick (2026-11-25): "备份钥匙和提示".
 *
 * The file holds what the phone is given of the vault (passwords.md, "iPhone"), and only for the
 * key items: the vault's id, KDF settings, aukSalt and password wrap, and each key item sealed as
 * stored. Opening it needs the master password and the Secret Key, as the vault does. The hint is
 * plain text, as in vault.json. No machine wrap, no recovery wrap, no other item.
 *
 * Written after every vault write while a key item exists (a new master password rewraps it), only
 * when its bytes change. `restoreLockedNotesKey` puts the key back into this computer's vault (a new
 * computer, a vault set up again): an item with the same key opens every locked note
 * (locked-note-store.ts tries every key item).
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { replaceAtomically } from '../drawings/vault-files.js'
import { deriveUnlockKey, fromB64, open, openJson, parseSecretKey, type KdfParams, type Sealed } from './crypto.js'
import { aadItem, aadItemKey, aadWrap, onVaultSaved, requireOpen, VaultError, type StoredItem } from './state.js'
import type { VaultItem } from './types.js'

export const KEY_BACKUP_FORMAT = 'walnut-locked-notes-key-backup'

export interface LockedNotesKeyBackup {
  format: typeof KEY_BACKUP_FORMAT
  version: 1
  vaultId: string
  kdf: KdfParams
  aukSalt: string
  wraps: { password: Sealed }
  hint?: string
  items: Record<string, StoredItem>
  /** Backups of other vaults this file held before (a computer set up again): kept, newest first. */
  earlier?: Array<Omit<LockedNotesKeyBackup, 'earlier'>>
}

export function keyBackupPath(): string {
  return path.join(WALNUT_HOME, 'locked-notes-key-backup.json')
}

export async function readKeyBackup(): Promise<LockedNotesKeyBackup | null> {
  try {
    const b = JSON.parse(await fsp.readFile(keyBackupPath(), 'utf8')) as LockedNotesKeyBackup
    return b?.format === KEY_BACKUP_FORMAT && b.version === 1 && b.wraps?.password && b.items ? b : null
  } catch {
    return null
  }
}

/** Write the backup from the open vault, when it has a key item and the bytes changed. */
export async function writeKeyBackup(): Promise<boolean> {
  const { isLockedNotesKeyItem } = await import('./locked-notes-key.js')
  const { f, items } = await requireOpen()
  const ids = [...items.values()].filter(isLockedNotesKeyItem).map((it) => it.id).filter((id) => f.items[id]).sort()
  if (!ids.length) return false
  const body: LockedNotesKeyBackup = {
    format: KEY_BACKUP_FORMAT, version: 1, vaultId: f.id, kdf: f.kdf, aukSalt: f.aukSalt,
    wraps: { password: f.wraps.password }, ...(f.hint ? { hint: f.hint } : {}),
    items: Object.fromEntries(ids.map((id) => [id, f.items[id]])),
  }
  // Another vault's backup here (this computer set up again, its key not restored yet) is never
  // dropped: it is the only way back to the notes that vault locked.
  const prior = await readKeyBackup()
  const earlier = [
    ...(prior && prior.vaultId !== f.id ? [withoutEarlier(prior)] : []),
    ...(prior?.earlier ?? []),
  ].filter((e, i, all) => e.vaultId !== f.id && all.findIndex((x) => x.vaultId === e.vaultId) === i)
  if (earlier.length) body.earlier = earlier
  const text = `${JSON.stringify(body, null, 2)}\n`
  const before = await fsp.readFile(keyBackupPath(), 'utf8').catch(() => null)
  if (before === text) return false
  await fsp.mkdir(path.dirname(keyBackupPath()), { recursive: true })
  await replaceAtomically(keyBackupPath(), text)
  return true
}

function withoutEarlier(b: LockedNotesKeyBackup): Omit<LockedNotesKeyBackup, 'earlier'> {
  const { earlier: _drop, ...rest } = b
  return rest
}

/** The backup of `vaultId` (default: the newest one), from the file or its earlier list. */
async function backupOf(vaultId?: string): Promise<Omit<LockedNotesKeyBackup, 'earlier'> | null> {
  const b = await readKeyBackup()
  if (!b) return null
  return [withoutEarlier(b), ...(b.earlier ?? [])].find((x) => !vaultId || x.vaultId === vaultId) ?? null
}

// After a vault write, once its caller took the new items into memory (mutate does that right after
// the write returns), the backup follows. A burst of writes is one backup.
let timer: ReturnType<typeof setTimeout> | null = null
let writing: Promise<unknown> = Promise.resolve()
const BACKUP_DELAY_MS = 300

function scheduleBackup(): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    writing = writing.then(writeKeyBackup).catch((err: unknown) => {
      // A locked vault (closed meanwhile) waits for the next write; anything else is worth a line.
      if (!(err instanceof VaultError && err.code === 'vault_locked')) {
        log.web.warn('locked notes key backup not written', { error: err instanceof Error ? err.message : String(err) })
      }
    })
  }, BACKUP_DELAY_MS)
  timer.unref?.()
}

onVaultSaved(scheduleBackup)

/** Tests: wait for a backup that is due. */
export async function settleKeyBackup(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; writing = writing.then(writeKeyBackup).catch(() => undefined) }
  await writing
}

export interface KeyBackupVault { vaultId: string; kdf: KdfParams; hint?: string; keys: number }

/** What the person is shown before a restore: each vault backed up here (newest first), its KDF and hint. */
export async function keyBackupInfo(): Promise<(KeyBackupVault & { earlier: KeyBackupVault[] }) | null> {
  const b = await readKeyBackup()
  if (!b) return null
  const one = (x: Omit<LockedNotesKeyBackup, 'earlier'>): KeyBackupVault => ({ vaultId: x.vaultId, kdf: x.kdf, ...(x.hint ? { hint: x.hint } : {}), keys: Object.keys(x.items).length })
  return { ...one(b), earlier: (b.earlier ?? []).map(one) }
}

/** The KDF settings of a backed-up vault, to derive its password key (the newest when none is named). */
export async function keyBackupKdf(vaultId?: string): Promise<KdfParams | null> {
  return (await backupOf(vaultId))?.kdf ?? null
}

/**
 * Open the backup of `vaultId` (the newest when none is named) with that vault's master password
 * (as its password key, derived with that backup's KDF) and Secret Key, and add each key it holds to this computer's open vault unless an
 * item already holds the same key. Answers how many were added.
 */
export async function restoreLockedNotesKey(p: { passwordKey: string; secretKey: string; vaultId?: string }): Promise<{ added: number }> {
  const b = await backupOf(p.vaultId)
  if (!b) throw new VaultError('There is no backup of the locked notes key in this Walnut\'s data folder', 404, 'no_key_backup')
  const sk = parseSecretKey(p.secretKey)
  if (!sk) throw new VaultError('That is not a Walnut Secret Key (it starts with W1-)', 400, 'bad_secret_key')
  let pw: Uint8Array
  try { pw = fromB64(p.passwordKey) } catch { throw new VaultError('passwordKey is not base64', 400, 'bad_password_key') }
  if (pw.length !== 32) throw new VaultError('passwordKey must be 32 bytes', 400, 'bad_password_key')
  let vk: Uint8Array
  try {
    vk = await open(await deriveUnlockKey(pw, sk, fromB64(b.aukSalt)), b.wraps.password, aadWrap(b.vaultId, 'password'))
  } catch {
    throw new VaultError('Wrong master password or Secret Key for the vault that locked these notes', 401, 'wrong_password')
  }
  const { isLockedNotesKeyItem, lockedNotesKeyValue, LOCKED_NOTES_KEY_TITLE } = await import('./locked-notes-key.js')
  const found: string[] = []
  for (const [id, s] of Object.entries(b.items)) {
    const ik = await open(vk, s.key, aadItemKey(b.vaultId, id))
    const it = await openJson<VaultItem>(ik, s.data, aadItem(b.vaultId, id))
    const value = isLockedNotesKeyItem(it) ? lockedNotesKeyValue(it) : undefined
    if (value) found.push(value)
  }
  const { items } = await requireOpen()
  const have = new Set([...items.values()].filter(isLockedNotesKeyItem).map(lockedNotesKeyValue))
  const missing = [...new Set(found)].filter((v) => !have.has(v))
  if (!missing.length) return { added: 0 }
  const { createItems } = await import('./items.js')
  const { LOCKED_NOTES_KEY_FIELD } = await import('./locked-notes-key.js')
  await createItems(missing.map((value) => ({
    type: 'note' as const,
    title: LOCKED_NOTES_KEY_TITLE,
    notes: 'Walnut opens your locked notes with this key (restored from the backup in your data folder). Deleting or changing it makes those notes unreadable, so Walnut keeps it as it is.',
    fields: [{ name: LOCKED_NOTES_KEY_FIELD, value, hidden: true }],
    agentAccess: 'never' as const,
    sensitive: true,
    tags: ['walnut'],
  })))
  return { added: missing.length }
}
