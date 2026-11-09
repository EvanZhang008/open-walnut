import fs from 'node:fs'
import path from 'node:path'
import Database from '../../src/lib/sqlite.js'

/** A WAL task store file at `version` under `home`, as the server leaves it. */
export function seedTaskStore(home: string, version = 13): string {
  const file = path.join(home, 'tasks', 'tasks.sqlite')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma(`user_version = ${version}`)
  db.close()
  return file
}

export function taskStoreVersion(file: string): number {
  const db = new Database(file)
  try {
    return db.pragma('user_version', { simple: true }) as number
  } finally {
    db.close()
  }
}
