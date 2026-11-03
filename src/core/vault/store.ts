/**
 * The vault store (docs/reference/passwords.md): set up, unlock, settings and the master
 * password over the files in state.ts; the items are in items.ts.
 *
 * A copy of vault.json alone (a backup, a stolen disk image without machine.json) needs the
 * master password AND the Secret Key from the recovery kit. A new master password, and turning
 * "agents may ask while you are away" off, make a new vault key: every item key is wrapped
 * again under it, so an old password with an old backup, or a machine key copied before,
 * opens nothing written since.
 */
import crypto from 'node:crypto'
import {
  PBKDF2_ITERATIONS, deriveUnlockKey, newSecretKey, open, parseSecretKey, randomBytes, seal, fromB64, toB64, type KdfParams,
} from './crypto.js'
import {
  VAULT_FORMAT, VAULT_VERSION, VaultError, aadWrap, commitSides, isOpen, loadFile, loadMachine, openGen, prepareSides, requireOpen,
  rewrapItems, saveFile, serial, setAsideMachine, setOpen, tryOpenWithMachine, writeMachine, decryptAll, type MachineFile, type VaultFile,
} from './state.js'

export { VAULT_FORMAT, VAULT_VERSION, VaultError, closeVault, isOpen, openKey, resetVaultForTest } from './state.js'
export type { VaultFile } from './state.js'
export {
  allItems, cleanInput, createItems, deleteItem, getItem, listItems, markUsed, restoreItem, setFavorite, trashItem, updateItem,
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
export async function setupVault(p: { passwordKey: string; kdf: KdfParams; agentsWhileAway: boolean }): Promise<{ secretKey: string; vaultId: string }> {
  checkKdf(p.kdf)
  const pw = pwKeyBytes(p.passwordKey)
  return serial(async () => {
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
    }
    await writeMachine({ version: 1, vaultId: id, secretKey, ...(machineKey ? { machineKey: toB64(machineKey) } : {}) })
    await saveFile(f)
    setOpen(key, new Map())
    return { secretKey, vaultId: id }
  })
}

/** Check the master password (as its password key) against the vault; the vault key on success. */
async function checkPassword(f: VaultFile, m: MachineFile | null, passwordKey: string, secretKey?: string) {
  const skText = secretKey ?? (m?.vaultId === f.id ? m.secretKey : undefined)
  if (!skText) throw new VaultError('This machine does not have the Secret Key: enter it from your recovery kit', 428, 'secret_key_needed')
  const sk = parseSecretKey(skText)
  if (!sk) throw new VaultError('That is not a Walnut Secret Key (it starts with W1-)', 400, 'bad_secret_key')
  const auk = await deriveUnlockKey(pwKeyBytes(passwordKey), sk, fromB64(f.aukSalt))
  try {
    return { key: await open(auk, f.wraps.password, aadWrap(f.id, 'password')), sk, skText }
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

async function machineOpens(f: VaultFile, machineKey: string): Promise<boolean> {
  try { await open(fromB64(machineKey), f.wraps.machine!, aadWrap(f.id, 'machine')); return true } catch { return false }
}

/**
 * Turn "agents may ask while nobody unlocked" on or off. Needs the master password: on puts
 * a key on this disk that opens the vault without it, off makes a new vault key so a copy of
 * that machine key opens nothing written from now on.
 */
export async function setAgentsWhileAway(on: boolean, passwordKey: string): Promise<void> {
  await serial(async () => {
    const gen = openGen()
    const cur = await requireOpen()
    const m = await loadMachine()
    if (!m || m.vaultId !== cur.f.id) throw new VaultError('This machine does not have the Secret Key', 428, 'secret_key_needed')
    const { sk } = await checkPassword(cur.f, m, passwordKey)
    const f = structuredClone(cur.f)
    const { machineKey: _drop, ...noKey } = m
    if (on) {
      if (f.wraps.machine && m.machineKey && await machineOpens(f, m.machineKey)) return
      // The key first, then the wrap: a crash between leaves a key that opens nothing.
      const mk = randomBytes(32)
      await writeMachine({ ...noKey, machineKey: toB64(mk) })
      f.wraps.machine = await seal(mk, cur.key, aadWrap(f.id, 'machine'))
      await saveFile(f)
      return
    }
    if (!f.wraps.machine && !m.machineKey) return
    // The key goes first: from then on nothing on this disk opens the vault without the password.
    await writeMachine(noKey)
    const newKey = randomBytes(32)
    await rewrapItems(f, cur.key, newKey)
    delete f.wraps.machine
    const auk = await deriveUnlockKey(pwKeyBytes(passwordKey), sk, fromB64(f.aukSalt))
    f.wraps.password = await seal(auk, newKey, aadWrap(f.id, 'password'))
    const sides = await prepareSides(f.id, cur.key, newKey)
    await saveFile(f)
    setOpen(newKey, cur.items, gen)
    await commitSides(sides)
  })
}

/** New master password: a new vault key, wrapped by the new password. Needs the old one. */
export async function changeMasterPassword(p: { oldPasswordKey: string; newPasswordKey: string; kdf: KdfParams }): Promise<void> {
  checkKdf(p.kdf)
  const newPw = pwKeyBytes(p.newPasswordKey)
  await serial(async () => {
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
    const newKey = randomBytes(32)
    await rewrapItems(f, cur.key, newKey)
    const aukSalt = randomBytes(16)
    f.kdf = p.kdf
    f.aukSalt = toB64(aukSalt)
    f.wraps.password = await seal(await deriveUnlockKey(newPw, sk, aukSalt), newKey, aadWrap(f.id, 'password'))
    if (f.wraps.machine && m?.machineKey) {
      // A new machine key too, so a copy of the old one opens nothing written from now on. It is
      // written first: a crash before vault.json leaves a key that opens nothing, and the
      // (old) password still opens the vault.
      const mk = randomBytes(32)
      await writeMachine({ ...m, machineKey: toB64(mk) })
      f.wraps.machine = await seal(mk, newKey, aadWrap(f.id, 'machine'))
    }
    const sides = await prepareSides(f.id, cur.key, newKey)
    await saveFile(f)
    setOpen(newKey, cur.items, gen)
    await commitSides(sides)
  })
}
