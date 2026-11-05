/**
 * The vault store (docs/reference/passwords.md): set up, unlock, settings and the master
 * password over the files in state.ts; the items are in items.ts.
 *
 * A copy of vault.json alone (a backup, a stolen disk image without machine.json) needs the
 * master password AND the Secret Key from the recovery kit. A new master password, and turning
 * "agents may ask while you are away" off, make a new vault key: every item key is wrapped
 * again under it, so an old password with an old backup, or a machine key copied before,
 * opens nothing written since.
 *
 * A forgotten master password: the recovery code in the recovery kit (with the Secret Key,
 * which this machine keeps) opens the vault once, sets a new master password and makes a new
 * recovery code. Every new vault key comes with a new recovery code (store.ts rotate), so an
 * old code, like an old password or machine key, opens nothing written since.
 */
import crypto from 'node:crypto'
import type { VaultItem } from './types.js'
import {
  PBKDF2_ITERATIONS, deriveRecoveryKey, deriveUnlockKey, newRecoveryCode, newSecretKey, open, parseRecoveryCode, parseSecretKey, secretKeyText, randomBytes, seal, fromB64, toB64, type KdfParams,
} from './crypto.js'
import {
  VAULT_FORMAT, VAULT_VERSION, VaultError, aadWrap, commitSides, isOpen, loadFile, loadMachine, openGen, prepareSides, requireOpen,
  mutate, rewrapItems, saveFile, serial, setAsideMachine, setOpen, tryOpenWithMachine, writeMachine, decryptAll, type MachineFile, type VaultFile,
} from './state.js'

export { VAULT_FORMAT, VAULT_VERSION, VaultError, closeVault, isOpen, openKey, resetVaultForTest } from './state.js'
export type { VaultFile } from './state.js'
export {
  allItems, cleanInput, createItems, deleteItem, getItem, listItems, markUsed, patchItem, restoreItem, setFavorite, trashItem, updateItem,
} from './items.js'

export interface VaultStatus {
  setUp: boolean
  /** The server holds the vault key now (it can serve approved agent requests). */
  open: boolean
  /** Agents may ask while nobody unlocked (the machine key exists). */
  agentsWhileAway: boolean
  /** What a client needs to derive its password key. */
  kdf?: KdfParams
  /** This machine has the Secret Key (else an unlock must bring it from the recovery kit). */
  hasSecretKey: boolean
  itemCount?: number
  vaultId?: string
  /** The vault has a recovery code (a vault set up before them has none until a new kit is made). */
  hasRecovery?: boolean
  /** Its newest recovery kit was never confirmed saved (a lost answer, a failed download): make a new one. */
  recoveryUnsaved?: boolean
  /** The master password hint the person wrote (hint.ts), shown on the unlock screen; absent when none. */
  hint?: string
}

export async function vaultStatus(): Promise<VaultStatus> {
  const f = await loadFile()
  if (!f) return { setUp: false, open: false, agentsWhileAway: false, hasSecretKey: false }
  const m = await loadMachine()
  if (!isOpen()) await tryOpenWithMachine()
  return {
    setUp: true,
    open: isOpen(),
    agentsWhileAway: !!(f.wraps.machine && m?.machineKey),
    kdf: f.kdf,
    hasSecretKey: !!m?.secretKey && m.vaultId === f.id,
    itemCount: Object.keys(f.items).length,
    vaultId: f.id,
    hasRecovery: hasLiveRecovery(f),
    recoveryUnsaved: hasLiveRecovery(f) && f.recoveryUnsaved === f.recoveryFor,
    ...(f.hint ? { hint: f.hint } : {}),
  }
}

export function checkKdf(kdf: KdfParams | undefined): void {
  if (!kdf || kdf.name !== 'PBKDF2-SHA256') throw new VaultError('kdf.name must be PBKDF2-SHA256', 400, 'bad_kdf')
  if (!Number.isInteger(kdf.iterations) || kdf.iterations < 600_000 || kdf.iterations > 10_000_000) throw new VaultError('kdf.iterations must be 600,000 to 10,000,000', 400, 'bad_kdf')
  let salt: Uint8Array
  try { salt = fromB64(String(kdf.salt)) } catch { throw new VaultError('kdf.salt is not base64', 400, 'bad_kdf') }
  if (salt.length < 16) throw new VaultError('kdf.salt must be at least 16 bytes', 400, 'bad_kdf')
}

function pwKeyBytes(pwKey: string): Uint8Array {
  let b: Uint8Array
  try { b = fromB64(pwKey) } catch { throw new VaultError('passwordKey is not base64', 400, 'bad_password_key') }
  if (b.length !== 32) throw new VaultError('passwordKey must be 32 bytes', 400, 'bad_password_key')
  return b
}

export function defaultKdf(): KdfParams {
  return { name: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: toB64(randomBytes(16)) }
}

/**
 * Make the vault. The client derives the password key from the master password and
 * `kdf`; the server makes the Secret Key and returns it once, for the recovery kit
 * (revealSecretKey shows it again for the master password).
 */
export async function setupVault(p: { passwordKey: string; kdf: KdfParams; agentsWhileAway: boolean; hint?: string }): Promise<{ secretKey: string; recoveryCode: string; vaultId: string }> {
  checkKdf(p.kdf)
  const pw = pwKeyBytes(p.passwordKey)
  const made = await serial(async () => {
    if (await loadFile()) throw new VaultError('A vault is already set up here', 409, 'vault_exists')
    const id = crypto.randomUUID()
    const secretKey = newSecretKey()
    const aukSalt = randomBytes(16)
    const auk = await deriveUnlockKey(pw, parseSecretKey(secretKey)!, aukSalt)
    const key = randomBytes(32)
    const now = new Date().toISOString()
    const machineKey = p.agentsWhileAway ? randomBytes(32) : null
    // A machine.json of an earlier vault (its vault.json deleted or moved) holds that vault's
    // Secret Key: keep it beside, never write over it.
    const prior = await loadMachine()
    if (prior) await setAsideMachine(prior)
    const f: VaultFile = {
      format: VAULT_FORMAT, version: VAULT_VERSION, id, rev: 0, createdAt: now, updatedAt: now,
      kdf: p.kdf, aukSalt: toB64(aukSalt),
      wraps: {
        password: await seal(auk, key, aadWrap(id, 'password')),
        ...(machineKey ? { machine: await seal(machineKey, key, aadWrap(id, 'machine')) } : {}),
      },
      items: {},
      ...(p.hint ? { hint: p.hint } : {}),
    }
    const recoveryCode = newRecoveryCode()
    f.wraps.recovery = await seal(await deriveRecoveryKey(parseRecoveryCode(recoveryCode)!, parseSecretKey(secretKey)!, id), key, aadWrap(id, 'recovery'))
    f.recoveryFor = f.recoveryUnsaved = recoveryFor(f)
    await writeMachine({ version: 1, vaultId: id, secretKey, ...(machineKey ? { machineKey: toB64(machineKey) } : {}) })
    await saveFile(f)
    setOpen(key, new Map())
    return { secretKey, recoveryCode, vaultId: id }
  })
  // A new vault's agent switch is written, never read from a default (policy.ts).
  const { writeNewVaultPolicy } = await import('./policy.js')
  await writeNewVaultPolicy()
  return made
}

/** Check the master password (as its password key) against the vault; the vault key on success. */
async function checkPassword(f: VaultFile, m: MachineFile | null, passwordKey: string, secretKey?: string) {
  const skText = secretKey ?? (m?.vaultId === f.id ? m.secretKey : undefined)
  if (!skText) throw new VaultError('This machine does not have the Secret Key: enter it from your recovery kit', 428, 'secret_key_needed')
  const sk = parseSecretKey(skText)
  if (!sk) throw new VaultError('That is not a Walnut Secret Key (it starts with W1-)', 400, 'bad_secret_key')
  const auk = await deriveUnlockKey(pwKeyBytes(passwordKey), sk, fromB64(f.aukSalt))
  try {
    return { key: await open(auk, f.wraps.password, aadWrap(f.id, 'password')), sk, skText: secretKeyText(sk) }
  } catch {
    throw new VaultError('Wrong master password', 401, 'wrong_password')
  }
}

/** Check a person's master password (as its password key). Opens the vault when it was closed. */
export async function unlockVault(p: { passwordKey: string; secretKey?: string }): Promise<void> {
  pwKeyBytes(p.passwordKey)
  await serial(async () => {
    const f = await loadFile()
    if (!f) throw new VaultError('No vault yet: set one up first', 409, 'vault_not_set_up')
    const m = await loadMachine()
    const { key, skText } = await checkPassword(f, m, p.passwordKey, p.secretKey)
    if (p.secretKey && (!m || m.vaultId !== f.id || m.secretKey !== skText)) {
      // A Secret Key brought from the recovery kit is kept, so the next unlock needs only the password.
      await writeMachine({ version: 1, vaultId: f.id, secretKey: skText, ...(m?.vaultId === f.id && m.machineKey ? { machineKey: m.machineKey } : {}) })
    }
    if (!isOpen()) setOpen(key, await decryptAll(f, key))
  })
}

/** The Secret Key, for a recovery kit made again. Needs the master password. */
export async function revealSecretKey(passwordKey: string): Promise<string> {
  return serial(async () => {
    const f = await loadFile()
    if (!f) throw new VaultError('No vault yet: set one up first', 409, 'vault_not_set_up')
    return (await checkPassword(f, await loadMachine(), passwordKey)).skText
  })
}

/**
 * Which password wrap a recovery wrap was made beside. Every rekey here writes both, so a
 * mismatch means an older Walnut (which knows no recovery wraps) rekeyed the vault: the
 * recovery wrap then opens an earlier vault key and is no recovery at all.
 */
function recoveryFor(f: VaultFile): string {
  return crypto.createHash('sha256').update(f.wraps.password.ct).digest('base64url')
}

/** What a recovery kit holds. */
export interface RecoveryKit { secretKey: string; recoveryCode: string }

function hasLiveRecovery(f: VaultFile): boolean {
  return !!f.wraps.recovery && f.recoveryFor === recoveryFor(f)
}

/**
 * A new vault key for an open vault, and everything that wraps it made again: the password
 * wrap (`auk`), a new machine key when `machine` keeps one, and a NEW recovery code when the
 * vault has one (or `recovery` asks for one). The code is never carried across: whoever held
 * the old vault key (a copied machine key, an old backup and password) must not get the new
 * one through it. Writes machine.json first (with the new machine key, or without one), so a
 * crash before vault.json leaves a key that opens nothing and the old secrets still open the
 * old file. Returns the new recovery code, if any.
 */
async function rotate(p: {
  gen: number; f: VaultFile; oldKey: Uint8Array; items: Map<string, VaultItem>; sk: Uint8Array; auk: Uint8Array
  machine: MachineFile; keepMachineKey: boolean; recovery: boolean
}): Promise<string | undefined> {
  const { f } = p
  const newKey = randomBytes(32)
  await rewrapItems(f, p.oldKey, newKey)
  f.wraps.password = await seal(p.auk, newKey, aadWrap(f.id, 'password'))
  let recoveryCode: string | undefined
  if (p.recovery) {
    recoveryCode = newRecoveryCode()
    f.wraps.recovery = await seal(await deriveRecoveryKey(parseRecoveryCode(recoveryCode)!, p.sk, f.id), newKey, aadWrap(f.id, 'recovery'))
    // The old kit no longer works and the new code lives only in this answer: until the person
    // confirms the new kit saved, Walnut says the vault has no saved recovery kit.
    f.recoveryFor = f.recoveryUnsaved = recoveryFor(f)
  } else {
    delete f.wraps.recovery
    delete f.recoveryFor
    delete f.recoveryUnsaved
  }
  const { machineKey: _drop, ...noKey } = p.machine
  const mk = p.keepMachineKey ? randomBytes(32) : null
  if (mk) f.wraps.machine = await seal(mk, newKey, aadWrap(f.id, 'machine'))
  else delete f.wraps.machine
  await writeMachine(mk ? { ...noKey, machineKey: toB64(mk) } : noKey)
  const sides = await prepareSides(f.id, p.oldKey, newKey)
  await saveFile(f)
  setOpen(newKey, p.items, p.gen)
  await commitSides(sides)
  return recoveryCode
}

/** The person saved the newest recovery kit (the kit screen's confirm). */
export async function confirmRecoveryKit(): Promise<void> {
  await serial(async () => {
    const cur = await loadFile()
    if (!cur?.recoveryUnsaved) return
    const f = structuredClone(cur)
    delete f.recoveryUnsaved
    await saveFile(f)
  })
}

const hasMachineKey = (f: VaultFile, m: MachineFile) => !!(f.wraps.machine && m.machineKey)

/**
 * A new recovery kit (or the first, for a vault set up before recovery codes). Needs the master
 * password. It makes a new vault key too, so the old code opens nothing, not even with a backup
 * of vault.json from before (the store keeps daily ones).
 */
export async function newRecoveryKit(passwordKey: string): Promise<RecoveryKit> {
  return serial(async () => {
    const gen = openGen()
    const cur = await requireOpen()
    const m = await loadMachine()
    if (!m || m.vaultId !== cur.f.id) throw new VaultError('This machine does not have the Secret Key', 428, 'secret_key_needed')
    const { sk, skText } = await checkPassword(cur.f, m, passwordKey)
    const f = structuredClone(cur.f)
    const auk = await deriveUnlockKey(pwKeyBytes(passwordKey), sk, fromB64(f.aukSalt))
    const recoveryCode = await rotate({ gen, f, oldKey: cur.key, items: cur.items, sk, auk, machine: m, keepMachineKey: hasMachineKey(f, m), recovery: true })
    return { secretKey: skText, recoveryCode: recoveryCode! }
  })
}

/**
 * A forgotten master password: the recovery code (and the Secret Key, which this machine keeps,
 * else from the kit) opens the vault, which gets a new master password, a new vault key and a
 * new recovery code. Returns the new kit; the old code opens nothing from now on.
 */
export async function recoverVault(p: { recoveryCode: string; secretKey?: string; newPasswordKey: string; kdf: KdfParams; hint?: string }): Promise<RecoveryKit> {
  checkKdf(p.kdf)
  const newPw = pwKeyBytes(p.newPasswordKey)
  return serial(async () => {
    const gen = openGen()
    const cur = await loadFile()
    if (!cur) throw new VaultError('No vault yet: set one up first', 409, 'vault_not_set_up')
    if (!cur.wraps.recovery) throw new VaultError('This vault has no recovery code: it was set up before them, and none was made since. Only the master password opens it.', 409, 'no_recovery')
    if (!hasLiveRecovery(cur)) throw new VaultError('This recovery code is out of date: an older Walnut changed the vault key since it was made. Only the master password opens the vault now.', 409, 'recovery_stale')
    let m = await loadMachine()
    const skText = p.secretKey || (m?.vaultId === cur.id ? m.secretKey : undefined)
    if (!skText) throw new VaultError('This machine does not have the Secret Key: enter it from your recovery kit', 428, 'secret_key_needed')
    const parsed = parseSecretKey(skText)
    if (!parsed) throw new VaultError('That is not a Walnut Secret Key (it starts with W1-)', 400, 'bad_secret_key')
    const sk = parsed
    const code = parseRecoveryCode(p.recoveryCode)
    if (!code) throw new VaultError('That is not a recovery code: it starts with R1- and is in your recovery kit', 400, 'bad_recovery_code')
    let key: Uint8Array
    try {
      key = await open(await deriveRecoveryKey(code, sk, cur.id), cur.wraps.recovery, aadWrap(cur.id, 'recovery'))
    } catch {
      throw new VaultError('That recovery code does not open this vault (or the Secret Key is not this vault\'s)', 401, 'wrong_recovery_code')
    }
    const items = await decryptAll(cur, key)
    const f = structuredClone(cur)
    const aukSalt = randomBytes(16)
    f.kdf = p.kdf
    f.aukSalt = toB64(aukSalt)
    setHint(f, p.hint)
    const auk = await deriveUnlockKey(newPw, sk, aukSalt)
    if (m && m.vaultId !== f.id) { await setAsideMachine(m); m = null }
    const keep = !!(m && hasMachineKey(f, m))
    const machine: MachineFile = { ...(m ?? { version: 1, vaultId: f.id }), version: 1, vaultId: f.id, secretKey: secretKeyText(sk) }
    const recoveryCode = await rotate({ gen, f, oldKey: key, items, sk, auk, machine, keepMachineKey: keep, recovery: true })
    return { secretKey: secretKeyText(sk), recoveryCode: recoveryCode! }
  })
}

async function machineOpens(f: VaultFile, machineKey: string): Promise<boolean> {
  try { await open(fromB64(machineKey), f.wraps.machine!, aadWrap(f.id, 'machine')); return true } catch { return false }
}

/**
 * Turn "agents may ask while nobody unlocked" on or off. Needs the master password: on puts
 * a key on this disk that opens the vault without it, off makes a new vault key so a copy of
 * that machine key opens nothing written from now on (and a new recovery code, returned).
 */
export async function setAgentsWhileAway(on: boolean, passwordKey: string): Promise<{ kit?: RecoveryKit }> {
  return serial(async () => {
    const gen = openGen()
    const cur = await requireOpen()
    const m = await loadMachine()
    if (!m || m.vaultId !== cur.f.id) throw new VaultError('This machine does not have the Secret Key', 428, 'secret_key_needed')
    const { sk } = await checkPassword(cur.f, m, passwordKey)
    const f = structuredClone(cur.f)
    const { machineKey: _drop, ...noKey } = m
    if (on) {
      if (f.wraps.machine && m.machineKey && await machineOpens(f, m.machineKey)) return {}
      // The key first, then the wrap: a crash between leaves a key that opens nothing.
      const mk = randomBytes(32)
      await writeMachine({ ...noKey, machineKey: toB64(mk) })
      f.wraps.machine = await seal(mk, cur.key, aadWrap(f.id, 'machine'))
      await saveFile(f)
      return {}
    }
    if (!f.wraps.machine && !m.machineKey) return {}
    const auk = await deriveUnlockKey(pwKeyBytes(passwordKey), sk, fromB64(f.aukSalt))
    const recoveryCode = await rotate({ gen, f, oldKey: cur.key, items: cur.items, sk, auk, machine: m, keepMachineKey: false, recovery: hasLiveRecovery(f) })
    return recoveryCode ? { kit: { secretKey: secretKeyText(sk), recoveryCode } } : {}
  })
}

/**
 * New master password: a new vault key, wrapped by the new password, and a new recovery code
 * when the vault has one (returned). Needs the old password.
 */
export async function changeMasterPassword(p: { oldPasswordKey: string; newPasswordKey: string; kdf: KdfParams; hint?: string }): Promise<{ kit?: RecoveryKit }> {
  checkKdf(p.kdf)
  const newPw = pwKeyBytes(p.newPasswordKey)
  return serial(async () => {
    const gen = openGen()
    const cur = await requireOpen()
    const m = await loadMachine()
    let sk: Uint8Array
    try {
      sk = (await checkPassword(cur.f, m, p.oldPasswordKey)).sk
    } catch (err) {
      if (err instanceof VaultError && err.code === 'wrong_password') throw new VaultError('Wrong current master password', 401, 'wrong_password')
      throw err
    }
    const f = structuredClone(cur.f)
    const aukSalt = randomBytes(16)
    f.kdf = p.kdf
    f.aukSalt = toB64(aukSalt)
    setHint(f, p.hint)
    const auk = await deriveUnlockKey(newPw, sk, aukSalt)
    // checkPassword found the Secret Key in machine.json, so it is this vault's.
    const recoveryCode = await rotate({ gen, f, oldKey: cur.key, items: cur.items, sk, auk, machine: m!, keepMachineKey: hasMachineKey(f, m!), recovery: hasLiveRecovery(f) })
    return recoveryCode ? { kit: { secretKey: secretKeyText(sk), recoveryCode } } : {}
  })
}

/** A new master password takes the hint that came with it; none (an older client sent none) drops the old one, which was about the old password. */
function setHint(f: VaultFile, hint: string | undefined): void {
  if (hint) f.hint = hint
  else delete f.hint
}

/** Change or remove the hint (the route checked it against the master password first). Needs the vault open. */
export async function setVaultHint(hint: string): Promise<void> {
  await mutate(async (s) => {
    setHint(s.f, hint)
    return { result: undefined }
  })
}
