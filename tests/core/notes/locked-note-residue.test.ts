/**
 * wipeFreedText (src/core/notes/locked-note-residue.ts): after a row's text is replaced, nothing of
 * the old text stays in the database file or its write-ahead log, as an agent reading the bytes
 * would find it. A temp database of the test's own, fake text only.
 */
import { describe, it, expect, afterEach } from 'vitest'
import Database from '../../../src/lib/sqlite.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { wipeFreedText } from '../../../src/core/notes/locked-note-residue.js'

const SECRET = 'wombatlighthousesecret'
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function bytesHold(file: string, word: string): boolean {
  return fs.existsSync(file) && fs.readFileSync(file).includes(Buffer.from(word))
}

describe('wipeFreedText', () => {
  it('leaves no byte of replaced text in the file, its free pages, its full-text index or its log', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locked-residue-'))
    dirs.push(dir)
    const file = path.join(dir, 'index.sqlite')
    const db = new Database(file)
    db.pragma('journal_mode = WAL')
    db.pragma('secure_delete = FAST')
    db.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE VIRTUAL TABLE notes_fts USING fts5(body, content='notes', content_rowid='id');`)
    const insert = db.prepare('INSERT INTO notes (id, body) VALUES (?, ?)')
    const indexRow = db.prepare('INSERT INTO notes_fts (rowid, body) VALUES (?, ?)')
    // Many versions of a long private note (each edit replaced the last), and other notes around it.
    for (let v = 0; v < 20; v++) {
      const body = `Version ${v}: ${SECRET} ${'and a long private line '.repeat(400)}`
      if (v > 0) {
        const old = db.prepare('SELECT body FROM notes WHERE id = 1').get() as { body: string }
        db.prepare(`INSERT INTO notes_fts (notes_fts, rowid, body) VALUES ('delete', 1, ?)`).run(old.body)
        db.prepare('UPDATE notes SET body = ? WHERE id = 1').run(body)
      } else {
        insert.run(1, body)
      }
      indexRow.run(1, body)
    }
    for (let i = 2; i < 200; i++) { insert.run(i, `other note ${i} `.repeat(50)); indexRow.run(i, `other note ${i} `.repeat(50)) }
    // Locked: the row holds the stub now.
    const last = db.prepare('SELECT body FROM notes WHERE id = 1').get() as { body: string }
    db.prepare(`INSERT INTO notes_fts (notes_fts, rowid, body) VALUES ('delete', 1, ?)`).run(last.body)
    db.prepare('UPDATE notes SET body = ? WHERE id = 1').run('**Locked note.** A stub.')
    indexRow.run(1, '**Locked note.** A stub.')
    expect(bytesHold(file, SECRET) || bytesHold(`${file}-wal`, SECRET)).toBe(true)

    const report = await wipeFreedText(db, ['notes_fts'])
    expect(report.walTruncated).toBe(true)
    expect(db.prepare(`SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH ?`).get(SECRET)).toEqual({ n: 0 })
    expect(db.prepare(`SELECT count(*) AS n FROM notes_fts WHERE notes_fts MATCH 'other'`).get()).toEqual({ n: 198 })
    db.close()
    expect(bytesHold(file, SECRET)).toBe(false)
    expect(bytesHold(`${file}-wal`, SECRET)).toBe(false)
    // The database still opens and reads the same.
    const again = new Database(file)
    expect((again.prepare('SELECT body FROM notes WHERE id = 1').get() as { body: string }).body).toBe('**Locked note.** A stub.')
    expect(again.pragma('integrity_check', { simple: true })).toBe('ok')
    again.close()
  })

  it('stops quietly when the database closes under it', async () => {
    const db = new Database(':memory:')
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(body)`)
    db.close()
    expect(await wipeFreedText(db, ['t'])).toEqual({ merged: 0, zeroedPages: 0, walTruncated: false })
  })
})
