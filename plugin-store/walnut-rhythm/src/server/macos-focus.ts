/**
 * Mirror the Mac's Focus into Walnut quiet mode: read which Focus is on, and name it.
 *
 * macOS keeps the live Focus in `~/Library/DoNotDisturb/DB/Assertions.json` and the
 * mode names in `ModeConfigurations.json` next to it. A Focus is on while
 * `data[0].storeAssertionRecords` is non-empty; the mode id is on each record at
 * `assertionDetails.assertionDetailsModeIdentifier`, and its name is at
 * `data[0].modeConfigurations[<id>].mode.name`.
 *
 * Exactly two named files are read, never a directory walk. Some macOS versions keep
 * this directory behind Full Disk Access, so a refused read is an expected state
 * ("unavailable"), reported once, never an error that repeats every poll.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface MacosFocus {
  active: boolean
  modeId?: string
  name?: string
}

export type MacosFocusRead =
  | { ok: true; focus: MacosFocus }
  | { ok: false; reason: 'permission' | 'unreadable'; message: string }

const DEFAULT_MODE_ID = 'com.apple.donotdisturb.mode.default'

/** Parse Assertions.json (and optionally ModeConfigurations.json). PURE. */
export function parseMacosFocus(assertions: unknown, modes?: unknown): MacosFocus {
  const records = firstData(assertions)?.storeAssertionRecords
  if (!Array.isArray(records) || records.length === 0) return { active: false }
  // Several assertions can be live; the most recently started one is the Focus the user sees.
  let latest: Record<string, unknown> | undefined
  let latestAt = -Infinity
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    const at = Number((record as Record<string, unknown>).assertionStartDateTimestamp)
    const when = Number.isFinite(at) ? at : 0
    if (!latest || when >= latestAt) { latest = record as Record<string, unknown>; latestAt = when }
  }
  const details = latest?.assertionDetails
  const modeId = details && typeof details === 'object'
    ? (details as Record<string, unknown>).assertionDetailsModeIdentifier
    : undefined
  const id = typeof modeId === 'string' && modeId ? modeId : undefined
  return { active: true, ...(id ? { modeId: id } : {}), name: modeName(id, modes) }
}

function firstData(json: unknown): Record<string, unknown> | undefined {
  if (!json || typeof json !== 'object') return undefined
  const data = (json as Record<string, unknown>).data
  const first = Array.isArray(data) ? data[0] : undefined
  return first && typeof first === 'object' ? first as Record<string, unknown> : undefined
}

/** The user's name for a mode, falling back to a readable form of its id. */
export function modeName(modeId: string | undefined, modes?: unknown): string {
  const configs = firstData(modes)?.modeConfigurations
  if (modeId && configs && typeof configs === 'object') {
    const entry = (configs as Record<string, unknown>)[modeId]
    const mode = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).mode : undefined
    const name = mode && typeof mode === 'object' ? (mode as Record<string, unknown>).name : undefined
    if (typeof name === 'string' && name.trim()) return name.trim()
  }
  if (!modeId || modeId === DEFAULT_MODE_ID) return 'Do Not Disturb'
  const tail = modeId.split('.').pop() ?? ''
  return tail ? tail.charAt(0).toUpperCase() + tail.slice(1) : 'Focus'
}

export function focusDbDir(home = os.homedir()): string {
  return path.join(home, 'Library', 'DoNotDisturb', 'DB')
}

export type ReadText = (file: string) => Promise<string>

const readUtf8: ReadText = (file) => fsp.readFile(file, 'utf8')

/**
 * Read the live Focus. A missing Assertions.json means no Focus has ever been on
 * (inactive, not an error). ModeConfigurations.json is optional: without it the name
 * falls back to the mode id.
 */
export async function readMacosFocus(dir = focusDbDir(), readText: ReadText = readUtf8): Promise<MacosFocusRead> {
  let assertions: unknown
  try {
    assertions = JSON.parse(await readText(path.join(dir, 'Assertions.json')))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: true, focus: { active: false } }
    if (code === 'EPERM' || code === 'EACCES') {
      return { ok: false, reason: 'permission', message: 'macOS did not allow reading the Focus state (Full Disk Access may be needed)' }
    }
    return { ok: false, reason: 'unreadable', message: error instanceof SyntaxError ? 'The Focus state file could not be parsed' : String((error as Error).message ?? error) }
  }
  const focus = parseMacosFocus(assertions)
  if (!focus.active) return { ok: true, focus }
  let modes: unknown
  try { modes = JSON.parse(await readText(path.join(dir, 'ModeConfigurations.json'))) } catch { modes = undefined }
  return { ok: true, focus: { ...focus, name: modeName(focus.modeId, modes) } }
}
