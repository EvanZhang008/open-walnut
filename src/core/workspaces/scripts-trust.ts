/**
 * The walnut.json files the user allowed to run their setup and teardown by
 * themselves (scripts.ts): content hashes in WALNUT_HOME/workspaces/scripts-trust.json.
 * A hash, not a path: the same commands are allowed wherever they appear, and
 * an edited file (another branch, a pull) asks again.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { writeFileAtomic } from '../config-store.js'

/** How many allowed files are kept (the newest). */
export const TRUST_KEEP = 50

const HASH = /^[a-f0-9]{16,64}$/

function trustPath(): string {
  return path.join(WALNUT_HOME, 'workspaces', 'scripts-trust.json')
}

export function cleanTrust(raw: unknown): string[] {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { allowed?: unknown }).allowed) ? (raw as { allowed: unknown[] }).allowed : []
  return list.filter((h): h is string => typeof h === 'string' && HASH.test(h)).slice(-TRUST_KEEP)
}

/** The list after allowing one more hash (moved to the newest end). */
export function withTrust(list: readonly string[], hash: string): string[] {
  return [...list.filter((h) => h !== hash), hash].slice(-TRUST_KEEP)
}

export async function readTrustFile(): Promise<string[]> {
  try {
    return cleanTrust(JSON.parse(await fs.readFile(trustPath(), 'utf8')))
  } catch {
    return []
  }
}

let writing: Promise<unknown> = Promise.resolve()

/** Add one hash; writes one at a time, so two allows never lose each other. */
export function allowInTrustFile(hash: string): Promise<string[]> {
  if (!HASH.test(hash)) return Promise.reject(new Error('not a file hash'))
  const next = writing.then(async () => {
    const list = withTrust(await readTrustFile(), hash)
    await fs.mkdir(path.dirname(trustPath()), { recursive: true })
    await writeFileAtomic(trustPath(), JSON.stringify({ allowed: list }, null, 2) + '\n')
    return list
  })
  writing = next.catch(() => {})
  return next
}
