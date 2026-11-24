/**
 * Walnut's pi extension (src/data/pi/walnut-claude-code.ts) is a copy on each host, written by
 * "Import from Claude Code". A fix to it reached nobody until the user imported again
 * (2026-11-24: pi's turns through Claude Code's gateway failed on a host whose copy predated the
 * fix). Before a pi session starts on a host, a copy Walnut wrote that is OLDER than the one this
 * Walnut ships is replaced by it. A host with no copy (never imported), a file Walnut did not
 * write, and a NEWER copy (a newer Walnut wrote it, the user went back) are left as they are.
 * Read and written through the host's daemon with the import's sha256 guard; a host that does not
 * answer in time keeps its copy, and the start goes on. Only a real install writes: a test or
 * ephemeral server shares the person's home and would change their pi.
 */

import path from 'node:path'
import { DaemonFileReader } from '../daemon-file-reader.js'
import { realInstall } from '../browser-control/extension-install.js'
import { log } from '../../logging/index.js'
import { EXTENSION_FILE_NAME, extensionVersionOf, guardedWrite, piAgentDir, readExtensionSource, type ImportTransport } from './claude-code-import.js'
import { WALNUT_CLAUDE_CODE_EXTENSION_VERSION } from '../../data/pi/walnut-claude-code.js'

const LOCAL_HOST = '__local__'
/** A start never waits longer than this for the check. */
export const PI_EXTENSION_REFRESH_DEADLINE_MS = 3_000

/** Hosts whose copy was found current (or updated) by this server: checked once per server run. */
const checked = new Set<string>()

export type PiExtensionRefresh = 'updated' | 'current' | 'absent' | 'foreign' | 'newer'

/** What to do with the host's copy: the shipped text, or why it stays. */
export function refreshPlan(current: string | null, shipped: string): { write: string } | { keep: Exclude<PiExtensionRefresh, 'updated'> } {
  if (current === null) return { keep: 'absent' }
  const version = extensionVersionOf(current)
  if (version === null) return { keep: 'foreign' }
  if (version > WALNUT_CLAUDE_CODE_EXTENSION_VERSION) return { keep: 'newer' }
  if (version === WALNUT_CLAUDE_CODE_EXTENSION_VERSION) return { keep: 'current' }
  return { write: shipped }
}

export async function refreshPiExtension(transport: ImportTransport): Promise<PiExtensionRefresh> {
  const file = path.posix.join(piAgentDir(transport.env), 'extensions', EXTENSION_FILE_NAME)
  const shipped = readExtensionSource()
  let kept: PiExtensionRefresh = 'current'
  const wrote = await guardedWrite(transport, file, (current) => {
    const plan = refreshPlan(current, shipped)
    if ('keep' in plan) { kept = plan.keep; return null }
    return plan.write
  })
  return wrote ? 'updated' : kept
}

/** A host's files as the import reads and writes them: through that host's daemon. */
export function hostImportTransport(host: string): ImportTransport {
  const reader = new DaemonFileReader(host)
  return {
    readBytes: (p, maxBytes) => reader.readFileBytes(p, maxBytes),
    listDir: (p) => reader.listDirStrict(p),
    writeAtomic: (p, text, expectSha256) => reader.writeFileAtomic(p, text, expectSha256),
    ...(host === LOCAL_HOST ? { env: process.env } : {}),
  }
}

/** Before a pi start on `host`: never throws, never waits past the deadline. */
export async function refreshPiExtensionBeforeStart(host: string, transport?: ImportTransport): Promise<PiExtensionRefresh | 'timeout' | 'failed' | 'skipped'> {
  // A transport passed in is a test's own; the host's files are written only by a real install.
  if (checked.has(host) || (!transport && !realInstall())) return 'skipped'
  transport ??= hostImportTransport(host)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      refreshPiExtension(transport),
      new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), PI_EXTENSION_REFRESH_DEADLINE_MS) }),
    ])
    if (result !== 'timeout') checked.add(host)
    if (result === 'updated') log.session.info('pi: Walnut\'s pi extension updated on the host', { host, version: WALNUT_CLAUDE_CODE_EXTENSION_VERSION })
    return result
  } catch (err) {
    log.session.warn('pi: could not check Walnut\'s pi extension on the host', { host, error: err instanceof Error ? err.message : String(err) })
    return 'failed'
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Tests only. */
export function __resetPiExtensionRefresh(): void { checked.clear() }
