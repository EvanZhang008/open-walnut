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
 * Written after every vault write and every open while a key item exists (a new master password
 * rewraps it), only when its bytes change. An entry is a vault id and its key items: one this file
 * held that the new one does not cover (another vault's, or this vault's with a key item it no longer
 * has, as after putting back an older vault.json) stays in `earlier`, with its own password wrap. A
 * file that does not read (damaged, a git conflict) is set aside, never overwritten; one a newer
 * Walnut wrote is left as it is. `restoreLockedNotesKey` puts the key back into this computer's vault (a new
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

type BackupFile = { state: 'none' } | { state: 'ok'; b: LockedNotesKeyBackup } | { state: 'unreadable' } | { state: 'newer' }

async function readBackupFile(): Promise<BackupFile> {
  let text: string
  try { text = await fsp.readFile(keyBackupPath(), 'utf8') } catch { return { state: 'none' } }
  try {
    const b = JSON.parse(text) as LockedNotesKeyBackup
    if (b?.format === KEY_BACKUP_FORMAT && typeof b.version === 'number' && b.version > 1) return { state: 'newer' }
    return b?.format === KEY_BACKUP_FORMAT && b.version === 1 && b.wraps?.password && b.items ? { state: 'ok', b } : { state: 'unreadable' }
  } catch {
    return { state: 'unreadable' }
  }
}

export async function readKeyBackup(): Promise<LockedNotesKeyBackup | null> {
  const r = await readBackupFile()
  return r.state === 'ok' ? r.b : null
}

type Entry = Omit<LockedNotesKeyBackup, 'earlier'>

/** One entry's name: its vault and its key items (ids are not secret: the file holds them in plain). */
export const entryOf = (e: Pick<Entry, 'vaultId' | 'items'>) => `${e.vaultId}:${Object.keys(e.items).sort().join(',')}`

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
  const file = await readBackupFile()
  // A newer Walnut's file: it may hold what this one cannot read, so it stays as it is.
  if (file.state === 'newer') return false
  // A file that does not read is kept beside it, for a person or a newer Walnut to read.
  if (file.state === 'unreadable') await fsp.rename(keyBackupPath(), `${keyBackupPath().replace(/\.json$/, '')}.unreadable-${Date.now()}.json`)
  const prior = file.state === 'ok' ? file.b : null
  // An entry the new one does not cover is never dropped: another vault's (this computer set up
  // again, its key not restored yet), or this vault's with a key item it lost. It is the only way
  // back to the notes those keys locked.
  const covered = (e: Entry) => e.vaultId === f.id && Object.keys(e.items).every((id) => body.items[id])
  const earlier = [...(prior ? [withoutEarlier(prior)] : []), ...(prior?.earlier ?? [])]
    .filter((e) => !covered(e))
    .filter((e, i, all) => all.findIndex((x) => entryOf(x) === entryOf(e)) === i)
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

/** Which backup: by its entry name, else the newest of `vaultId`, else the newest of all. */
export interface BackupPick { entry?: string; vaultId?: string }

async function backupOf(pick: BackupPick = {}): Promise<Entry | null> {
  const b = await readKeyBackup()
  if (!b) return null
  const all = [withoutEarlier(b), ...(b.earlier ?? [])]
  if (pick.entry) return all.find((x) => entryOf(x) === pick.entry) ?? null
  return all.find((x) => !pick.vaultId || x.vaultId === pick.vaultId) ?? null
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

/** Wait for a backup that is due (a lock waits for it before it seals with the key; tests too). */
export async function settleKeyBackup(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; writing = writing.then(writeKeyBackup).catch(() => undefined) }
  await writing
}

/**
 * One backup as the person is shown it before a restore. `inVault`: every key item it holds is in
 * the open vault already (a restore adds nothing). `holdsNoteKey`: it holds the key item the note
 * being opened names.
 */
export interface KeyBackupVault { entry: string; vaultId: string; kdf: KdfParams; hint?: string; keys: number; inVault: boolean; holdsNoteKey?: boolean }

/** Each backup here (newest first), its KDF and hint; `noteKey`: the key item id the note being opened names. */
export async function keyBackupInfo(noteKey?: string): Promise<(KeyBackupVault & { earlier: KeyBackupVault[] }) | null> {
  const b = await readKeyBackup()
  if (!b) return null
  const { isLockedNotesKeyItem } = await import('./locked-notes-key.js')
  const { items } = await requireOpen()
  const one = (x: Entry): KeyBackupVault => ({
    entry: entryOf(x), vaultId: x.vaultId, kdf: x.kdf, ...(x.hint ? { hint: x.hint } : {}), keys: Object.keys(x.items).length,
    inVault: Object.keys(x.items).every((id) => isLockedNotesKeyItem(items.get(id))),
    ...(noteKey ? { holdsNoteKey: !!x.items[noteKey] } : {}),
  })
  return { ...one(b), earlier: (b.earlier ?? []).map(one) }
}

/** The KDF settings of a backed-up vault, to derive its password key. */
export async function keyBackupKdf(pick: BackupPick = {}): Promise<KdfParams | null> {
  return (await backupOf(pick))?.kdf ?? null
}

/**
 * Open one backup (`entry`, else the newest of `vaultId`, else the newest) with that vault's master password
 * (as its password key, derived with that backup's KDF) and Secret Key, and add each key it holds to this computer's open vault unless an
 * item already holds the same key. Answers how many were added.
 */
export async function restoreLockedNotesKey(p: BackupPick & { passwordKey: string; secretKey: string }): Promise<{ added: number }> {
  const b = await backupOf(p)
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
