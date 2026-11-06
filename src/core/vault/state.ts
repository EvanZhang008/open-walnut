/**
 * The vault's files and in-memory state (store.ts is the API over it, docs/reference/passwords.md).
 *
 * vault.json holds only ciphertext and the parameters needed to open it:
 *   { format, version, id, rev, kdf, aukSalt, wraps: { password, machine?, recovery? }, recoveryFor?, hint?, items: { <id>: { key, data, updatedAt } } }
 * (`hint`, the master password hint, is the one plain-text field the person writes: hint.ts.)
 * machine.json (0600) holds what only this machine keeps: the Secret Key, and the machine key
 * while the person lets agents ask with nobody at the vault. Side files (agent-log.json,
 * policy.json, agent-grants.json, bitwarden-sync.json, browsers.json) are sealed with the vault key and resealed when it changes.
 *
 * The vault key (VK) stays in this process's memory while the vault is open. Opening it is
 * not a person's unlock: every item read through the API needs a person's vault session.
 *
 * One writer: every change runs under one in-process queue (`serial`), works on copies of
 * the file and the items, and replaces the in-memory state only after the write succeeded
 * (`mutate`), so a failed write (a full disk) leaves memory and disk the same. Each write is a
 * temp file plus fsync plus rename; the previous vault.json is kept as a daily copy in backups/.
 * A vault.json changed by hand (a backup put back) is read again and its items decrypted again,
 * inside the queue, so a read that races a write never mistakes our own write for an outside one.
 * A close (Lock all, the last window gone) wins over any change still running: `closeGen`.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { vaultDir } from './paths.js'
import { open, openJson, seal, sealJson, fromB64, type KdfParams, type Sealed } from './crypto.js'
import type { VaultItem } from './types.js'

export const VAULT_FORMAT = 'walnut-vault'
export const VAULT_VERSION = 1
const BACKUPS_KEPT = 14
/** Files beside vault.json sealed with the vault key; a key change reseals each. */
export const SIDE_FILES = ['agent-log.json', 'policy.json', 'agent-grants.json', 'bitwarden-sync.json', 'browsers.json'] as const
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
  /** recovery: VK under the recovery key (crypto.ts, "Keys"); absent for a vault set up before recovery codes. */
  wraps: { password: Sealed; machine?: Sealed; recovery?: Sealed }
  /** The password wrap the recovery wrap was made beside (store.ts recoveryFor). */
  recoveryFor?: string
  /** Set to recoveryFor while the newest recovery kit was not confirmed saved by the person. */
  recoveryUnsaved?: string
  /** The master password hint (hint.ts): plain text, shown on the unlock screen. An older Walnut keeps it as it is. */
  hint?: string
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
/** Bumped by every close: a change that began before it never puts a key or items back. */
let closeGen = 0
const inQueue = new AsyncLocalStorage<true>()

/** Tests: point the store at a directory and forget everything in memory. */
export function resetVaultForTest(d: string | null): void {
  dirOverride = d
  vk = null
  cache = null
  fileCache = null
  opening = null
  queue = Promise.resolve()
  closeGen++
}

export async function dir(): Promise<string> {
  return dirOverride ?? vaultDir()
}

/** One change at a time. Work already in the queue runs nested work at once (never waits on itself). */
export function serial<T>(work: () => Promise<T>): Promise<T> {
  if (inQueue.getStore()) return work()
  const job = () => inQueue.run(true, work)
  const run = queue.then(job, job)
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

/**
 * The vault file as on disk now. A file that differs from the one we know is read again only
 * inside the queue: outside it, the difference may be a write of ours that has renamed its file
 * and not yet recorded it, so the read waits its turn and looks again.
 */
export async function loadFile(): Promise<VaultFile | null> {
  const file = path.join(await dir(), 'vault.json')
  let st: fs.Stats | null = null
  try { st = await fsp.stat(file) } catch { st = null }
  if (fileCache && st && fileCache.mtimeMs === st.mtimeMs && fileCache.size === st.size) return fileCache.f
  if (!inQueue.getStore()) return serial(() => loadFile())
  if (!st) { fileCache = null; return null }
  const f = await readJson<VaultFile>(file)
  if (!f) { fileCache = null; return null }
  if (f.format !== VAULT_FORMAT || typeof f.version !== 'number') throw new VaultError('vault.json is not a Walnut vault', 500, 'vault_unreadable')
  if (f.version > VAULT_VERSION) throw new VaultError(`This vault was written by a newer Walnut (format ${f.version}); update Walnut to open it`, 409, 'vault_newer')
  const changedOutside = !!fileCache
  fileCache = { f, mtimeMs: st.mtimeMs, size: st.size }
  if (changedOutside && vk) {
    // Put back by hand: decrypt again with the key we hold, or close when it no longer opens it.
    const key = vk
    try { cache = await decryptAll(f, key) } catch { if (vk === key) { vk = null; cache = null } }
  }
  return f
}

export async function loadMachine(): Promise<MachineFile | null> {
  return readJson<MachineFile>(path.join(await dir(), 'machine.json'))
}

export async function writeMachine(m: MachineFile): Promise<void> {
  await writeAtomic(path.join(await dir(), 'machine.json'), m)
}

/** Move a machine.json of another vault aside (`machine-<vaultId>.json`) before a new vault takes its place. */
export async function setAsideMachine(m: MachineFile): Promise<void> {
  const d = await dir()
  await fsp.rename(path.join(d, 'machine.json'), path.join(d, `machine-${String(m.vaultId).replace(/[^\w-]/g, '_')}-${Date.now()}.json`))
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
      const gen = closeGen
      const f = await loadFile()
      const m = await loadMachine()
      if (!f || !m?.machineKey || !f.wraps.machine || m.vaultId !== f.id) return false
      let key: Uint8Array
      try {
        key = await open(fromB64(m.machineKey), f.wraps.machine, aadWrap(f.id, 'machine'))
      } catch {
        return false // a machine key that does not open this wrap (a crash between two writes): the password opens it
      }
      const items = await decryptAll(f, key)
      if (!vk && gen === closeGen) { cache = items; vk = key }
      return !!vk
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
    const gen = closeGen
    const cur = await requireOpen()
    const s: OpenState = { f: structuredClone(cur.f), key: cur.key, items: new Map(cur.items) }
    const out = await fn(s)
    if (out.write !== false) await saveFile(s.f)
    // Closed meanwhile: the write stands, but nothing goes back into memory.
    if (gen === closeGen) {
      cache = s.items
      if (out.key) vk = out.key
    }
    return out.result
  })
}

/** The close generation, for a change that installs a key later (setOpen). */
export function openGen(): number {
  return closeGen
}

/** Install a freshly opened, made or rekeyed vault's key and items, unless it was closed since `gen`. */
export function setOpen(key: Uint8Array, items: Map<string, VaultItem>, gen: number = closeGen): void {
  if (gen !== closeGen) return
  vk = key
  cache = items
}

/** Forget the vault key: nothing in this process can read the vault until it is opened again. */
export function closeVault(): void {
  closeGen++
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
  // `<name>.next` is the copy sealed under a new key before vault.json took that key (a rekey
  // that crashed before renaming it): it is the one that opens then.
  for (const file of [name, `${name}.next`]) {
    const body = await readJson<SideFileBody>(path.join(await dir(), file))
    if (!body || body.vaultId !== vaultId) continue
    try {
      return await openJson<T>(key, body.data, aadSide(vaultId, name))
    } catch { /* sealed under another key: try the other copy */ }
  }
  return null
}

async function writeSide(name: SideFile, vaultId: string, key: Uint8Array, value: unknown): Promise<void> {
  const d = await dir()
  await writeAtomic(path.join(d, name), { version: 1, vaultId, data: await sealJson(key, value, aadSide(vaultId, name)) } satisfies SideFileBody)
  await fsp.rm(path.join(d, `${name}.next`), { force: true }) // a rekey's copy left by a crash is older now
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

/**
 * A rekey, step one (inside the queue, before vault.json takes the new key): seal every side
 * file again under the new key as `<name>.next`. Step two, after vault.json is written:
 * commitSides renames them over the old ones. A crash between leaves both, and readSide finds
 * whichever opens with the key vault.json holds.
 */
export async function prepareSides(vaultId: string, oldKey: Uint8Array, newKey: Uint8Array): Promise<SideFile[]> {
  const ready: SideFile[] = []
  for (const name of SIDE_FILES) {
    const v = await readSide<unknown>(name, vaultId, oldKey)
    if (v === null) continue
    await writeAtomic(path.join(await dir(), `${name}.next`), { version: 1, vaultId, data: await sealJson(newKey, v, aadSide(vaultId, name)) } satisfies SideFileBody)
    ready.push(name)
  }
  return ready
}

export async function commitSides(ready: SideFile[]): Promise<void> {
  const d = await dir()
  for (const name of ready) await fsp.rename(path.join(d, `${name}.next`), path.join(d, name)).catch(() => undefined)
}

/** Rewrap every item key under a new vault key (items' own ciphertext is untouched). */
export async function rewrapItems(f: VaultFile, oldKey: Uint8Array, newKey: Uint8Array): Promise<void> {
  for (const [id, s] of Object.entries(f.items)) {
    const ik = await open(oldKey, s.key, aadItemKey(f.id, id))
    f.items[id] = { ...s, key: await seal(newKey, ik, aadItemKey(f.id, id)) }
  }
}
