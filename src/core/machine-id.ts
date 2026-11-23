/**
 * This machine's stable id, as the server reads it: `<home>/.local/state/open-walnut/machine-id`,
 * 32 lowercase hex, made once per OS account and never rewritten (providers/machine-id-core.ts
 * has the rule, shared with the daemon twins, which send it in their hello).
 *
 * It is outside every Walnut data dir on purpose: a new, moved or copied data dir keeps the
 * machine's id, and a copy of the data dir on another machine does not carry it. A file that does
 * not exist yet is seeded from the id an older build kept in the data dir (WALNUT_HOME/local/
 * machine-id, which keyed the daemon update stores; the seed rule is machine-id-core.ts's, the
 * same in both daemon twins). The update stores also still read entries kept under that older id
 * (readLegacyMachineId), so a stable id seeded elsewhere first orphans none of them.
 *
 * readMachineId is the one to call; readMachineIdSync only on a boot path that cannot wait (never
 * on a request). Both remember the id: it is read from disk once per process.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WALNUT_HOME } from '../constants.js'
import { log } from '../logging/index.js'
import { isMachineId, machineIdOf } from '../providers/machine-id-core.js'

let homeForTest: string | null = null
/** The id read so far, per home (a test may point the home elsewhere). */
const known = new Map<string, string>()

function accountHome(): string {
  return homeForTest ?? os.homedir()
}

/** Where this machine's id is kept for the account whose home is `home`. */
export function machineIdFile(home: string = accountHome()): string {
  return path.join(home, '.local', 'state', 'open-walnut', 'machine-id')
}

/** The id an older build kept in the data dir: read only, as the seed of a missing file. */
export function legacyMachineIdFile(): string {
  return path.join(WALNUT_HOME, 'local', 'machine-id')
}

/** The id an older build kept in this data dir (the update stores' old key), or null: none or not one. Never made. */
export async function readLegacyMachineId(): Promise<string | null> {
  const text = (await fsp.readFile(legacyMachineIdFile(), 'utf8').catch(() => '')).trim()
  return isMachineId(text) ? text : null
}

/** This machine's id, read or made once (sync: only for a boot path that cannot be async). */
export function readMachineIdSync(): string {
  const home = accountHome()
  const kept = known.get(home)
  if (kept) return kept
  const id = machineIdOf({
    home,
    dataHome: WALNUT_HOME,
    fs,
    join: path.join,
    randomHex: () => randomBytes(16).toString('hex'),
    log: (level, message, data) => log.session[level](message, data),
  })
  known.set(home, id)
  return id
}

/** This machine's id, read or made once. Rejects only when it can be neither read nor made. */
export async function readMachineId(): Promise<string> {
  const home = accountHome()
  const kept = known.get(home)
  if (kept) return kept
  // Another process may be writing it this moment: wait for it here, never in the sync rule's
  // short blocking wait (machine-id-core.ts settled), which would hold this event loop.
  for (let tries = 0; tries < 10; tries++) {
    const read = await fsp.readFile(machineIdFile(home), 'utf8').then((t) => t.trim(), (err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? null : ''))
    if (read !== null && isMachineId(read)) {
      known.set(home, read)
      return read
    }
    if (read === null) break
    await new Promise((r) => setTimeout(r, 20))
  }
  // Not made yet (once per machine), or broken: the shared rule makes it, a few small file calls.
  return readMachineIdSync()
}

/** Tests: read the id from under `home` instead of the account's (null: the account's again); forgets what was read. */
export function setMachineIdHomeForTest(home: string | null): void {
  homeForTest = home
  known.clear()
}

const HOLDER_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * This machine's id, or null when it cannot be had: the named file missing or not holding one,
 * or the stable id neither readable nor makeable. Sync: read at boot (the stable id is read from
 * disk once per process, made once per machine).
 */
export function permitHolderId(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.WALNUT_MACHINE_ID_FILE) {
    let text: string
    try {
      text = fs.readFileSync(env.WALNUT_MACHINE_ID_FILE, 'utf8').trim()
    } catch {
      return null
    }
    return HOLDER_ID_RE.test(text) ? text : null
  }
  try {
    return readMachineIdSync()
  } catch {
    return null
  }
}
