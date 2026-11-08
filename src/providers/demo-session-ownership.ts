import fs from 'node:fs/promises'
import path from 'node:path'
import { writeJsonFile } from '../utils/fs.js'

export interface DemoOwnership {
  v: 1
  home: string
  own: string[]
  threads: string[]
  adapters: Array<[string, string]>
  /**
   * Fresh ids this server minted for a start that passed its gate, confirmed or not
   * (a start refused because Claude Code was not installed yet). Never another
   * Walnut's, so a restart must not read them as copied; they allow a start or a
   * resume under the same id (a proven run then owns it), never a write into one or
   * a fork of one. Absent in older files.
   */
  minted?: string[]
}

export async function readDemoOwnership(home: string): Promise<DemoOwnership> {
  const empty: DemoOwnership = { v: 1, home, own: [], threads: [], adapters: [] }
  const file = path.join(home, 'local', 'demo-session-ownership.json')
  try {
    const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    let data: DemoOwnership
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || process.getuid && stat.uid !== process.getuid()) throw new Error('Demo session ownership file is not owned by this account')
      data = JSON.parse(await handle.readFile('utf8')) as DemoOwnership
    } finally { await handle.close() }
    const localKey = (value: unknown) => typeof value === 'string' && value.startsWith('__local__\u0000') && value.length > '__local__\u0000'.length
    const ownKey = (value: unknown) => localKey(value) && (value as string).split('\u0000').length === 2
    const threadKey = (value: unknown) => localKey(value) && (value as string).split('\u0000').length === 3
      && (value as string).split('\u0000').slice(1).every(Boolean)
    if (!data || data.v !== 1 || data.home !== home || !Array.isArray(data.own) || !data.own.every(ownKey)
      || !Array.isArray(data.threads) || !data.threads.every(threadKey)
      || !Array.isArray(data.adapters) || !data.adapters.every(row => Array.isArray(row) && row.length === 2 && ownKey(row[0]) && typeof row[1] === 'string')
      || (data.minted !== undefined && (!Array.isArray(data.minted) || !data.minted.every(ownKey)))) {
      throw new Error('Demo session ownership is invalid; no inherited session was accepted')
    }
    return data
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty
    throw error
  }
}

let writes: Promise<void> = Promise.resolve()
export function writeDemoOwnership(value: DemoOwnership): Promise<void> {
  const snapshot = structuredClone(value)
  const next = writes.catch(() => {}).then(() => writeJsonFile(path.join(value.home, 'local', 'demo-session-ownership.json'), snapshot, { mode: 0o600, durable: true }))
  writes = next
  return next
}
