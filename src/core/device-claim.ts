/**
 * First-boot claim flow (Home Assistant/Gitea pattern), cloud mode: while
 * auth.json has ZERO devices, a one-time setup token (15-min validity,
 * regenerated on restart/expiry) is printed to stdout. POST
 * /api/v1/setup/claim exchanges it for the first device token, after which the
 * claim path closes permanently.
 *
 * The claimed device is the companion's OWNER (device-store.ts `owner`) when
 * the claim says it is a computer (`device`, the self-report the setup wizard
 * sends, the one the Mac sends its companion later): the Mac that set the
 * companion up is the one that holds the setup token. A claim that says
 * nothing about the device (a hand typed curl), or says a phone, records no
 * owner: a phone is never the owner, and with none recorded the first computer
 * to mint a machine credential becomes it (machine-credentials.ts), as before
 * owners were recorded.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { log } from '../logging/index.js'
import { cleanSelfInfo, freshRecord, hashesEqual, platformFromInfo, readRegistry, sha256Hex, updateAuth, validateDeviceName } from './device-store.js'

const SETUP_TOKEN_TTL_MS = 15 * 60 * 1000
/**
 * A provisioned token (a pairing code burned into the VM's cloud-init) gets a
 * far longer window than a printed one: the operator generated it BEFORE the
 * box existed, and first boot (image pull, npm ci, a full build, Let's Encrypt)
 * routinely outlives 15 minutes.
 */
const PROVISIONED_SETUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

// Module-level setup-token state. Regenerated on process restart (module reload)
// and on expiry. Only meaningful while the device list is empty.
let setupToken: { token: string; expiresAt: number; provisioned: boolean } | null = null

/** True once at least one device is paired (claim path closed). */
export async function isClaimed(): Promise<boolean> {
  return (await readRegistry()).devices.length > 0
}

/**
 * Read a setup token supplied by provisioning (the "pairing code" the operator's
 * Walnut generated locally and burned into this box's cloud-init), instead of
 * having the box mint one and print it to the journal.
 *
 * Two shapes, env wins: `WALNUT_SETUP_TOKEN` (value) or `WALNUT_SETUP_TOKEN_FILE`
 * (path). The file path is NEVER defaulted in code: it always arrives via the
 * env var that scripts/cloud/setup.sh sets, so a dev Mac never reads a stray
 * file and tests stay hermetic.
 */
async function readProvisionedSetupToken(): Promise<{ token: string; source: 'env' | 'file' } | null> {
  let candidate: string | undefined
  let source: 'env' | 'file' = 'env'
  const fromEnv = process.env.WALNUT_SETUP_TOKEN
  if (fromEnv) {
    candidate = fromEnv
  } else {
    const file = process.env.WALNUT_SETUP_TOKEN_FILE
    if (file) {
      source = 'file'
      try {
        candidate = await fs.readFile(file, 'utf-8')
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
          // Only ENOENT is the normal "this box wasn't provisioned" case. EACCES
          // in particular means the file IS there and the operator's pairing
          // code is dead, and that failure was invisible for a whole release.
          log.web.error('device-auth: provisioned setup token file exists but could not be read: falling back to a random setup token, so the pairing code will NOT claim this instance', {
            file,
            code,
            error: err instanceof Error ? err.message : String(err),
          })
        }
        return null
      }
    }
  }
  if (candidate === undefined) return null
  const token = candidate.trim()
  if (!/^[0-9a-f]{32}$/.test(token)) {
    // The operator holds a pairing code that will NEVER work: say so loudly
    // rather than silently falling back to a token only the journal knows.
    log.web.error('device-auth: provisioned setup token is malformed (expected 32 lowercase hex chars): falling back to a random setup token, so the pairing code will NOT claim this instance', {
      source,
      length: token.length,
    })
    return null
  }
  return { token, source }
}

/**
 * Get the current setup token, ONLY while zero devices exist. Lazily generates
 * (and regenerates on expiry). Returns null once the instance is claimed.
 * Callers that surface it to the operator should use printSetupTokenBanner(),
 * but only when `provisioned` is false; a provisioned token must never be
 * echoed, the operator already has it.
 */
export async function getSetupTokenIfUnclaimed(): Promise<{ token: string; expiresAt: number; provisioned: boolean } | null> {
  if (await isClaimed()) {
    setupToken = null
    return null
  }
  if (!setupToken || Date.now() > setupToken.expiresAt) {
    const provisioned = await readProvisionedSetupToken()
    if (provisioned) {
      setupToken = {
        token: provisioned.token,
        expiresAt: Date.now() + PROVISIONED_SETUP_TOKEN_TTL_MS,
        provisioned: true,
      }
      // Deliberately omits the token value, like the random-path log below.
      log.web.warn('device-auth: adopted provisioned setup token', {
        source: provisioned.source,
        expiresAt: new Date(setupToken.expiresAt).toISOString(),
      })
    } else {
      setupToken = {
        token: crypto.randomBytes(16).toString('hex'),
        expiresAt: Date.now() + SETUP_TOKEN_TTL_MS,
        provisioned: false,
      }
      log.web.warn('device-auth: setup token generated (instance unclaimed)', {
        expiresAt: new Date(setupToken.expiresAt).toISOString(),
      })
    }
  }
  return setupToken
}

/**
 * Print the setup-token banner to stdout (greppable via journalctl on a cloud
 * box). This is one of the two intentional plaintext-token prints: the
 * structured logger above deliberately omits the token itself.
 */
export function printSetupTokenBanner(token: string, expiresAt: number): void {
  const lines = [
    '',
    '==============================================================',
    '  WALNUT CLOUD SETUP: instance is UNCLAIMED',
    '',
    `  Setup token: ${token}`,
    `  Valid until: ${new Date(expiresAt).toISOString()} (15 min)`,
    '',
    '  Claim it with:',
    '    curl -X POST https://<host>/api/v1/setup/claim \\',
    `      -H 'Content-Type: application/json' \\`,
    `      -d '{"setupToken":"${token}","deviceName":"my-mac"}'`,
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
 * device, and permanently close the claim path (devices > 0 → claim
 * rejected). `device` is the claimer's self-report, recorded as its first one:
 * when it says a computer, the claimer is recorded as the owner (see the top
 * of this file). The emptiness check and the write are one locked step, so
 * two claims racing cannot both land.
 */
export async function claimInstance(candidateToken: string, deviceName: string, device?: unknown): Promise<{ name: string; token: string; owner: boolean }> {
  if (await isClaimed()) {
    throw new Error('Instance already claimed')
  }
  // Validate against the CURRENT setup token only, never regenerate here.
  // An expired token means the operator must restart the server for a fresh
  // banner; silently rotating during a failed claim would strand the printed one.
  if (!setupToken || Date.now() > setupToken.expiresAt) {
    throw new Error('Invalid or expired setup token')
  }
  // Constant-time compare on hashes (uniform-length buffers).
  if (!hashesEqual(sha256Hex(candidateToken ?? ''), sha256Hex(setupToken.token))) {
    throw new Error('Invalid or expired setup token')
  }
  validateDeviceName(deviceName)
  const info = device === undefined ? undefined : cleanSelfInfo(device)
  const platform = platformFromInfo(info)
  const { name, token } = await updateAuth((auth) => {
    if (auth.devices.length > 0) throw new Error('Instance already claimed')
    const { record, token } = freshRecord(deviceName)
    // The claim's report is the device's first: what it says it is stays (setDeviceInfo).
    if (info && platform) Object.assign(record, { info, platform })
    auth.devices.push(record)
    // Only a computer by its own word: a phone, or a device that said nothing, is no owner.
    if (platform === 'other') auth.owner = { id: record.id!, via: 'claim' }
    return { persist: true, result: { name: record.name, token } }
  })
  setupToken = null // closed: the first device made isClaimed() true anyway
  // A provisioned pairing code must not linger on disk once it has been spent.
  // Best-effort: the claim already succeeded, so a failed unlink is not an error
  // worth failing on. (Any env-var copy of the token in the systemd unit is inert
  // from here on: the claim path is closed forever.)
  const tokenFile = process.env.WALNUT_SETUP_TOKEN_FILE
  if (tokenFile) {
    try { await fs.unlink(tokenFile) } catch { /* already gone / read-only FS */ }
  }
  log.web.info('device-auth: instance claimed', { deviceName: name, owner: platform === 'other', ...(platform ? { platform } : {}) })
  return { name, token, owner: platform === 'other' }
}

/** Test-only: forget the setup token. */
export function resetClaimForTesting(): void {
  setupToken = null
}
