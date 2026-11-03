/**
 * The vault's files and in-memory state (store.ts is the API over it, docs/reference/passwords.md).
 *
 * vault.json holds only ciphertext and the parameters needed to open it:
 *   { format, version, id, rev, kdf, aukSalt, wraps: { password, machine? }, items: { <id>: { key, data, updatedAt } } }
 * machine.json (0600) holds what only this machine keeps: the Secret Key, and the machine key
 * while the person lets agents ask with nobody at the vault. Side files (agent-log.json,
 * policy.json) are sealed with the vault key and resealed when it changes.
 *
 * The vault key (VK) stays in this process's memory while the vault is open. Opening it is
 * not a person's unlock: every item read through the API needs a person's vault session.
 *
 * One writer: every change runs under one in-process queue (`serial`), works on copies of
 * the file and the items, and replaces the in-memory state only after the write succeeded
 * (`mutate`), so a failed write (a full disk) leaves memory and disk the same. Each write is a
 * temp file plus fsync plus rename; the previous vault.json is kept as a daily copy in backups/.
 * A vault.json changed by hand (a backup put back) is read again and its items decrypted again.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { vaultDir } from './paths.js'
import { open, openJson, seal, sealJson, fromB64, type KdfParams, type Sealed } from './crypto.js'
import type { VaultItem } from './types.js'

export const VAULT_FORMAT = 'walnut-vault'
export const VAULT_VERSION = 1
const BACKUPS_KEPT = 14
/** Files beside vault.json sealed with the vault key; a key change reseals each. */
export const SIDE_FILES = ['agent-log.json', 'policy.json'] as const
export type SideFile = typeof SIDE_FILES[number]

export interface StoredItem { key: Sealed; data: Sealed; updatedAt: string }

export interface VaultFile {
  format: typeof VAULT_FORMAT
  version: number
  id: string
  rev: number
  createdAt: string
  updatedAt: string
  kdf: KdfParams
  /** base64 */
  aukSalt: string
  wraps: { password: Sealed; machine?: Sealed }
  items: Record<string, StoredItem>
}

export interface MachineFile {
  version: 1
  vaultId: string
  secretKey: string
  /** base64; present while agents may ask with nobody at the vault. */
  machineKey?: string
}

interface SideFileBody { version: 1; vaultId: string; data: Sealed }

export class VaultError extends Error {
  constructor(message: string, public status: number, public code: string) {
    super(message)
    this.name = 'VaultError'
  }
}

export const aadWrap = (vaultId: string, kind: string) => `walnut-vault:${vaultId}:wrap:${kind}`
export const aadItemKey = (vaultId: string, id: string) => `walnut-vault:${vaultId}:item-key:${id}`
export const aadItem = (vaultId: string, id: string) => `walnut-vault:${vaultId}:item:${id}`
const aadSide = (vaultId: string, name: string) => `walnut-vault:${vaultId}:side:${name}`

// ── in-memory state ──

let dirOverride: string | null = null
let vk: Uint8Array | null = null
let cache: Map<string, VaultItem> | null = null
let fileCache: { f: VaultFile; mtimeMs: number; size: number } | null = null
let opening: Promise<boolean> | null = null
let queue: Promise<unknown> = Promise.resolve()

/** Tests: point the store at a directory and forget everything in memory. */
export function resetVaultForTest(d: string | null): void {
  dirOverride = d
  vk = null
  cache = null
  fileCache = null
  opening = null
  queue = Promise.resolve()
}

export async function dir(): Promise<string> {
  return dirOverride ?? vaultDir()
}

export function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work)
  queue = run.catch(() => undefined)
  return run
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new VaultError(`The vault file ${path.basename(file)} cannot be read: ${(err as Error).message}`, 500, 'vault_unreadable')
  }
}

export async function writeAtomic(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  const fh = await fsp.open(tmp, 'w', 0o600)
  try {
    await fh.writeFile(JSON.stringify(value))
    await fh.sync()
  } finally {
    await fh.close()
  }
  try {
    await fsp.rename(tmp, file)
  } catch (err) {
    await fsp.rm(tmp, { force: true })
    throw err
  }
}

/** The vault file as on disk now (read again when something else changed it). */
export async function loadFile(): Promise<VaultFile | null> {
  const file = path.join(await dir(), 'vault.json')
  let st: fs.Stats | null = null
  try { st = await fsp.stat(file) } catch { st = null }
  if (!st) { fileCache = null; return null }
  if (fileCache && fileCache.mtimeMs === st.mtimeMs && fileCache.size === st.size) return fileCache.f
  const f = await readJson<VaultFile>(file)
  if (!f) { fileCache = null; return null }
  if (f.format !== VAULT_FORMAT || typeof f.version !== 'number') throw new VaultError('vault.json is not a Walnut vault', 500, 'vault_unreadable')
  if (f.version > VAULT_VERSION) throw new VaultError(`This vault was written by a newer Walnut (format ${f.version}); update Walnut to open it`, 409, 'vault_newer')
  const changedOutside = !!fileCache
  fileCache = { f, mtimeMs: st.mtimeMs, size: st.size }
  if (changedOutside && vk) {
    // Put back by hand: decrypt again with the key we hold, or close when it no longer opens it.
    try { cache = await decryptAll(f, vk) } catch { vk = null; cache = null }
  }
  return f
}

export async function loadMachine(): Promise<MachineFile | null> {
  return readJson<MachineFile>(path.join(await dir(), 'machine.json'))
}

export async function writeMachine(m: MachineFile): Promise<void> {
  await writeAtomic(path.join(await dir(), 'machine.json'), m)
}

/** Keep one copy of the previous vault.json per day (ciphertext), newest BACKUPS_KEPT. Never fails a write. */
async function backupDaily(d: string): Promise<void> {
  try {
    const src = path.join(d, 'vault.json')
    if (!fs.existsSync(src)) return
    const bdir = path.join(d, 'backups')
    const name = `vault-${new Date().toISOString().slice(0, 10)}.json`
    await fsp.mkdir(bdir, { recursive: true, mode: 0o700 })
    if (!fs.existsSync(path.join(bdir, name))) await fsp.copyFile(src, path.join(bdir, name))
    const all = (await fsp.readdir(bdir)).filter((n) => /^vault-\d{4}-\d\d-\d\d\.json$/.test(n)).sort()
    for (const old of all.slice(0, Math.max(0, all.length - BACKUPS_KEPT))) await fsp.rm(path.join(bdir, old), { force: true })
  } catch { /* a backup is a convenience: the write itself goes on */ }
}

/** Write `f` (a copy: the cache takes it only after the write succeeded). */
export async function saveFile(f: VaultFile): Promise<void> {
  const d = await dir()
  await backupDaily(d)
  const next: VaultFile = { ...f, rev: f.rev + 1, updatedAt: new Date().toISOString() }
  const file = path.join(d, 'vault.json')
  await writeAtomic(file, next)
  const st = await fsp.stat(file)
  fileCache = { f: next, mtimeMs: st.mtimeMs, size: st.size }
}

export async function decryptAll(f: VaultFile, key: Uint8Array): Promise<Map<string, VaultItem>> {
  const out = new Map<string, VaultItem>()
  for (const [id, s] of Object.entries(f.items)) {
    const ik = await open(key, s.key, aadItemKey(f.id, id))
    out.set(id, await openJson<VaultItem>(ik, s.data, aadItem(f.id, id)))
  }
  return out
}

/** Open the vault with the machine key, when that wrap exists. One opening at a time. */
async function openWithMachine(): Promise<boolean> {
  if (vk) return true
  if (!opening) {
    opening = (async () => {
      const f = await loadFile()
      const m = await loadMachine()
      if (!f || !m?.machineKey || !f.wraps.machine || m.vaultId !== f.id) return false
      const key = await open(fromB64(m.machineKey), f.wraps.machine, aadWrap(f.id, 'machine'))
      const items = await decryptAll(f, key)
      if (!vk) { cache = items; vk = key }
      return true
    })().finally(() => { opening = null })
  }
  return opening
}

export function isOpen(): boolean {
  return !!vk
}

export async function tryOpenWithMachine(): Promise<boolean> {
  return openWithMachine().catch(() => false)
}

export interface OpenState { f: VaultFile; key: Uint8Array; items: Map<string, VaultItem> }

export async function requireOpen(): Promise<OpenState> {
  const f = await loadFile()
  if (!f) throw new VaultError('No vault yet: set one up first', 409, 'vault_not_set_up')
  if (!vk) await openWithMachine()
  if (!vk || !cache) throw new VaultError('The vault is locked: unlock it with the master password', 423, 'vault_locked')
  return { f, key: vk, items: cache }
}

/**
 * One change: `fn` edits copies of the file and the item map (replacing items, never editing
 * one in place) and may return a new key; memory takes the copies only after the write.
 */
export async function mutate<R>(fn: (s: OpenState) => Promise<{ result: R; key?: Uint8Array; write?: boolean }>): Promise<R> {
  return serial(async () => {
    const cur = await requireOpen()
    const s: OpenState = { f: structuredClone(cur.f), key: cur.key, items: new Map(cur.items) }
    const out = await fn(s)
    if (out.write !== false) await saveFile(s.f)
    cache = s.items
    if (out.key) vk = out.key
    return out.result
  })
}

/** Install a freshly opened or made vault's key and items (setup, unlock). */
export function setOpen(key: Uint8Array, items: Map<string, VaultItem>): void {
  vk = key
  cache = items
}

/** Forget the vault key: nothing in this process can read the vault until it is opened again. */
export function closeVault(): void {
  vk = null
  cache = null
}

// ── side files ──

/** The open vault's id and key. */
export async function openKey(): Promise<{ vaultId: string; key: Uint8Array }> {
  const { f, key } = await requireOpen()
  return { vaultId: f.id, key }
}

async function readSide<T>(name: SideFile, vaultId: string, key: Uint8Array): Promise<T | null> {
  const body = await readJson<SideFileBody>(path.join(await dir(), name))
  if (!body || body.vaultId !== vaultId) return null
  try {
    return await openJson<T>(key, body.data, aadSide(vaultId, name))
  } catch {
    return null
  }
}

async function writeSide(name: SideFile, vaultId: string, key: Uint8Array, value: unknown): Promise<void> {
  await writeAtomic(path.join(await dir(), name), { version: 1, vaultId, data: await sealJson(key, value, aadSide(vaultId, name)) } satisfies SideFileBody)
}

/** A side file's contents (null when absent or unreadable). Needs the vault open. */
export async function openSide<T>(name: SideFile): Promise<T | null> {
  return serial(async () => {
    const { f, key } = await requireOpen()
    return readSide<T>(name, f.id, key)
  })
}

/** Read, change and seal a side file in one step of the queue. */
export async function updateSide<T>(name: SideFile, fn: (cur: T | null) => T): Promise<T> {
  return serial(async () => {
    const { f, key } = await requireOpen()
    const next = fn(await readSide<T>(name, f.id, key))
    await writeSide(name, f.id, key, next)
    return next
  })
}

/** Seal every side file again under a new vault key (called inside the queue, before vault.json is written). */
export async function resealSides(vaultId: string, oldKey: Uint8Array, newKey: Uint8Array): Promise<void> {
  for (const name of SIDE_FILES) {
    const v = await readSide<unknown>(name, vaultId, oldKey)
    if (v !== null) await writeSide(name, vaultId, newKey, v)
  }
}

/** Rewrap every item key under a new vault key (items' own ciphertext is untouched). */
export async function rewrapItems(f: VaultFile, oldKey: Uint8Array, newKey: Uint8Array): Promise<void> {
  for (const [id, s] of Object.entries(f.items)) {
    const ik = await open(oldKey, s.key, aadItemKey(f.id, id))
    f.items[id] = { ...s, key: await seal(newKey, ik, aadItemKey(f.id, id)) }
  }
}
