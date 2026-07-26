/**
 * Device-token authentication for cloud mode.
 *
 * auth.json (<OPEN_WALNUT_HOME>/auth.json, mode 0600) holds a device list with
 * SHA-256 hashes of 128-bit random Bearer tokens. Plaintext tokens are shown
 * exactly once (CLI `walnut device add` output / first-boot setup banner) and
 * are never persisted or logged anywhere else.
 *
 * First-boot claim flow (Home Assistant/Gitea pattern): while auth.json has
 * ZERO devices, a one-time setup token (15-min validity, regenerated on
 * restart/expiry) is printed to stdout. POST /api/v1/setup/claim exchanges it
 * for the first device token, after which the claim path closes permanently.
 *
 * IMPORTANT: auth.json must NEVER enter the OPEN_WALNUT_HOME git-sync repo —
 * see CRITICAL_IGNORES in src/integrations/git-sync.ts.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../constants.js'
import { log } from '../logging/index.js'

export interface DeviceRecord {
  name: string
  /** sha256 hex of the plaintext token — the token itself is never stored. */
  tokenHash: string
  createdAt: string
  lastUsedAt?: string
  /**
   * 'machine' = daemon bridge credential: accepted ONLY for the /bridge WS
   * upgrade, rejected on every REST route. Absent = normal paired device.
   */
  kind?: 'machine'
}

interface AuthFile {
  devices: DeviceRecord[]
}

/** Public device info — never includes hashes. */
export interface DeviceInfo {
  name: string
  createdAt: string
  lastUsedAt?: string
}

const SETUP_TOKEN_TTL_MS = 15 * 60 * 1000
/** Persist lastUsedAt at most once per device per this window (avoid write amplification). */
const LAST_USED_WRITE_THROTTLE_MS = 60_000

// Module-level setup-token state. Regenerated on process restart (module reload)
// and on expiry. Only meaningful while the device list is empty.
let setupToken: { token: string; expiresAt: number } | null = null
// Per-device throttle for lastUsedAt disk writes.
const lastUsedWriteAt = new Map<string, number>()

function authFilePath(): string {
  return path.join(WALNUT_HOME, 'auth.json')
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf-8').digest('hex')
}

/** Constant-time compare of two sha256 hex digests. */
function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex')
  const bufB = Buffer.from(b, 'hex')
  if (bufA.length !== 32 || bufB.length !== 32) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

/**
 * Load auth.json. Missing file → zero devices (normal first boot).
 * Corrupt file → zero devices (claim flow reopens) but log an error so the
 * operator notices — a corrupt file silently locking everyone IN would be
 * worse than requiring a re-pair.
 */
async function loadAuth(): Promise<AuthFile> {
  const file = authFilePath()
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch {
    // Missing is normal before first pairing — but it is ALSO what a lost
    // auth.json looks like, and the two are indistinguishable here. On
    // 2026-07-26 a merge carrying a remote deletion removed auth.json on both
    // the primary and the cloud box; every device token silently stopped
    // validating and git sync died on a bare 401 for six hours. The sidecar
    // makes that recoverable; git-sync now also keeps auth.json untracked so
    // the deletion cannot reach disk in the first place.
    const recovered = await readAuthBackup()
    if (recovered) {
      log.web.error('auth.json missing — recovered the device registry from auth.json.bak. Every device token would otherwise have stopped validating.', {
        file,
        devices: recovered.devices.length,
      })
      // Put the primary back so the next read is a plain hit.
      try { await saveAuth(recovered) } catch { /* read-only FS / racing writer */ }
      return recovered
    }
    return { devices: [] } // missing with no backup — genuine first boot
  }
  try {
    const parsed = JSON.parse(raw) as AuthFile
    if (!Array.isArray(parsed.devices)) throw new Error('devices is not an array')
    return { devices: parsed.devices.filter((d) => d && typeof d.name === 'string' && typeof d.tokenHash === 'string') }
  } catch (err) {
    log.web.error('auth.json is corrupt — treating as zero devices (claim flow reopens)', {
      file,
      error: err instanceof Error ? err.message : String(err),
    })
    return { devices: [] }
  }
}

/**
 * Sidecar copy of the device registry, for the same reason config.yaml has one:
 * losing it is unrecoverable from anywhere else and presents as a blanket 401.
 * Gitignored + kept untracked by git-sync's CRITICAL_IGNORES — never synced
 * (each box pairs its own devices).
 */
function authBackupPath(): string {
  return `${authFilePath()}.bak`
}

/** Read the sidecar. Returns null when absent, empty, or unparseable. */
async function readAuthBackup(): Promise<AuthFile | null> {
  try {
    const raw = await fs.readFile(authBackupPath(), 'utf-8')
    const parsed = JSON.parse(raw) as AuthFile
    if (!Array.isArray(parsed.devices)) return null
    const devices = parsed.devices.filter((d) => d && typeof d.name === 'string' && typeof d.tokenHash === 'string')
    return devices.length > 0 ? { devices } : null
  } catch {
    return null
  }
}

/** Write auth.json atomically with mode 0600, mirroring to the sidecar. */
async function saveAuth(auth: AuthFile): Promise<void> {
  const file = authFilePath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 })
  await fs.rename(tmp, file)
  // Mirror AFTER the primary lands, so the sidecar never leads the real file.
  // Never throws: a failed backup must not fail a device pairing.
  try {
    const btmp = `${authBackupPath()}.tmp-${process.pid}`
    await fs.writeFile(btmp, JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 })
    await fs.rename(btmp, authBackupPath())
  } catch (err) {
    log.web.warn('failed to update auth.json.bak', { error: err instanceof Error ? err.message : String(err) })
  }
}

function validateDeviceName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
    throw new Error('Invalid device name: use 1-64 chars of letters, digits, dot, dash, underscore')
  }
}

/**
 * Create a new device. Returns the plaintext token ONCE — it is never stored
 * or shown again. 128-bit random → 32 hex chars.
 */
export async function createDevice(name: string, opts?: { kind?: 'machine' }): Promise<{ name: string; token: string; createdAt: string }> {
  validateDeviceName(name)
  const auth = await loadAuth()
  if (auth.devices.some((d) => d.name === name)) {
    throw new Error(`Device "${name}" already exists`)
  }
  const token = crypto.randomBytes(16).toString('hex')
  const createdAt = new Date().toISOString()
  auth.devices.push({ name, tokenHash: sha256Hex(token), createdAt, ...(opts?.kind ? { kind: opts.kind } : {}) })
  await saveAuth(auth)
  log.web.info('device-auth: device created', { name, kind: opts?.kind ?? 'device' })
  return { name, token, createdAt }
}

/**
 * Verify a Bearer token against the device list (constant-time hash compare).
 * On success, updates the device's lastUsedAt — throttled to at most one disk
 * write per device per minute.
 */
export async function verifyDeviceToken(token: string): Promise<{ name: string; kind?: 'machine' } | null> {
  if (!token || typeof token !== 'string') return null
  const auth = await loadAuth()
  const candidateHash = sha256Hex(token)
  // Compare against every device (no early exit) so timing doesn't reveal
  // which position matched.
  let matched: DeviceRecord | null = null
  for (const device of auth.devices) {
    if (hashesEqual(candidateHash, device.tokenHash)) matched = device
  }
  if (!matched) return null

  const now = Date.now()
  const lastWrite = lastUsedWriteAt.get(matched.name) ?? 0
  if (now - lastWrite >= LAST_USED_WRITE_THROTTLE_MS) {
    lastUsedWriteAt.set(matched.name, now)
    matched.lastUsedAt = new Date(now).toISOString()
    // Best-effort — a failed lastUsedAt write must never fail auth.
    try {
      await saveAuth(auth)
    } catch (err) {
      log.web.warn('device-auth: failed to persist lastUsedAt', {
        name: matched.name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return matched.kind ? { name: matched.name, kind: matched.kind } : { name: matched.name }
}

/** Revoke a device by name. Returns true if it existed. */
export async function revokeDevice(name: string): Promise<boolean> {
  const auth = await loadAuth()
  const before = auth.devices.length
  auth.devices = auth.devices.filter((d) => d.name !== name)
  if (auth.devices.length === before) return false
  await saveAuth(auth)
  lastUsedWriteAt.delete(name)
  log.web.info('device-auth: device revoked', { name })
  return true
}

/** List devices — never exposes token hashes. */
export async function listDevices(): Promise<DeviceInfo[]> {
  const auth = await loadAuth()
  return auth.devices.map(({ name, createdAt, lastUsedAt }) => ({ name, createdAt, lastUsedAt }))
}

/** True once at least one device is paired (claim path closed). */
export async function isClaimed(): Promise<boolean> {
  const auth = await loadAuth()
  return auth.devices.length > 0
}

/**
 * Get the current setup token — ONLY while zero devices exist. Lazily generates
 * (and regenerates on expiry). Returns null once the instance is claimed.
 * Callers that surface it to the operator should use printSetupTokenBanner().
 */
export async function getSetupTokenIfUnclaimed(): Promise<{ token: string; expiresAt: number } | null> {
  if (await isClaimed()) {
    setupToken = null
    return null
  }
  if (!setupToken || Date.now() > setupToken.expiresAt) {
    setupToken = {
      token: crypto.randomBytes(16).toString('hex'),
      expiresAt: Date.now() + SETUP_TOKEN_TTL_MS,
    }
    log.web.warn('device-auth: setup token generated (instance unclaimed)', {
      expiresAt: new Date(setupToken.expiresAt).toISOString(),
    })
  }
  return setupToken
}

/**
 * Print the setup-token banner to stdout (greppable via journalctl on a cloud
 * box). This is one of the two intentional plaintext-token prints — the
 * structured logger above deliberately omits the token itself.
 */
export function printSetupTokenBanner(token: string, expiresAt: number): void {
  const lines = [
    '',
    '==============================================================',
    '  WALNUT CLOUD SETUP — instance is UNCLAIMED',
    '',
    `  Setup token: ${token}`,
    `  Valid until: ${new Date(expiresAt).toISOString()} (15 min)`,
    '',
    '  Claim it with:',
    '    curl -X POST https://<host>/api/v1/setup/claim \\',
    `      -H 'Content-Type: application/json' \\`,
    `      -d '{"setupToken":"${token}","deviceName":"my-phone"}'`,
    '',
    '  The response contains your device token (shown once).',
    '  This path closes permanently after the first device is paired.',
    '==============================================================',
    '',
  ]
  process.stdout.write(lines.join('\n'))
}

/**
 * Claim an unclaimed instance: validate the setup token, create the first
 * device, and permanently close the claim path (devices > 0 → claim rejected).
 */
export async function claimInstance(candidateToken: string, deviceName: string): Promise<{ name: string; token: string }> {
  if (await isClaimed()) {
    throw new Error('Instance already claimed')
  }
  // Validate against the CURRENT setup token only — never regenerate here.
  // An expired token means the operator must restart the server for a fresh
  // banner; silently rotating during a failed claim would strand the printed one.
  if (!setupToken || Date.now() > setupToken.expiresAt) {
    throw new Error('Invalid or expired setup token')
  }
  // Constant-time compare on hashes (uniform-length buffers).
  if (!hashesEqual(sha256Hex(candidateToken ?? ''), sha256Hex(setupToken.token))) {
    throw new Error('Invalid or expired setup token')
  }
  const { name, token } = await createDevice(deviceName)
  setupToken = null // closed — createDevice made isClaimed() true anyway
  log.web.info('device-auth: instance claimed', { deviceName: name })
  return { name, token }
}

/** Test-only: clear module-level state (setup token + write throttle). */
export function _resetDeviceAuthForTesting(): void {
  setupToken = null
  lastUsedWriteAt.clear()
}
