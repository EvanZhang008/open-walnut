/**
 * A locked note's text is nowhere on disk in the clear (docs/reference/locked-notes.md, "What is on
 * disk"): an agent with a shell that reads files directly (cat, grep, strings over every database and
 * log) finds only ciphertext. The note is first a plain note, indexed and searched like any other,
 * then locked, shown, edited sealed, and read by an approved agent; afterwards every byte of the
 * test's Walnut home and its log folder is scanned for the note's words, and its git history for
 * the words written after the lock. Fake data only.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-locked-notes-disk-scan'))

import { WALNUT_HOME, LOG_DIR } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { derivePasswordKey, randomBytes, toB64, type KdfParams } from '../../src/core/vault/crypto.js'
import { resetVaultForTest } from '../../src/core/vault/store.js'
import { resetSessionsForTest } from '../../src/core/vault/sessions.js'
import { notesRoot } from '../../src/core/notes/note-paths.js'
import { settleLockedNoteResidue, wipePendingPath } from '../../src/core/notes/locked-note-residue.js'

let base = ''
let session = ''
let stopped = false
const kdf: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000, salt: toB64(randomBytes(16)) }
const MASTER = 'a disk scan master phrase'
const AGENT = { 'x-walnut-caller-sid': 'sess-disk-scan-agent' }
const NOTE = 'journal/Private week.md'
// Words of the note's text before the lock (it was a plain note, indexed and searched) ...
// The last: a term whose first letter no other indexed word shares, so the full-text index stores it
// whole (FTS5 keeps a term as the part after the prefix it shares with the one before it).
const BEFORE = ['marmosetlanternword', 'quillfjordsecret', 'Walked to the harbour alone at dawn', 'zyxwombatprivate']
// ... and words written only after the lock (never plain on disk at any moment).
const AFTER = ['tapirvelvetafter', 'Repainted the garden fence in the afternoon']
// A diary-like note: a heading, Unicode (escaped), and a body long enough to fill several pages.
// Searched for (so the query string in the access log is this word, not one of the scanned ones).
const SEARCH_WORD = 'okapisearchmarker'
const TEXT = [
  '# Private week',
  `Search marker: ${SEARCH_WORD}.`,
  `Monday: ${BEFORE[2]}. The word is ${BEFORE[0]}.`,
  `Tuesday: ${BEFORE[1]}, caf\u00e9 and \u4f60\u597d\u4e16\u754c.`,
  `Wednesday: ${BEFORE[3]}.`,
  ...Array.from({ length: 120 }, (_, i) => `- entry line ${i} of an ordinary private week`),
  '',
].join('\n')

async function http(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(session ? { 'x-walnut-vault-session': session } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let parsed: Record<string, any> = {}
  try { parsed = text ? JSON.parse(text) : {} } catch { parsed = { raw: text } }
  return { status: res.status, body: parsed }
}
const v1 = (method: string, p: string, body?: unknown, headers?: Record<string, string>) => http(method, `/api/v1${p}`, body, headers)

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (ok(v) || Date.now() > until) return v
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** Every file under `dir` (databases, their WAL and journal files, logs, caches), as bytes. */
function filesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) out.push(p)
    }
  }
  walk(dir)
  return out
}

/** Where each word appears in the clear (UTF-8, and UTF-16 for databases that use it), as `file: word`. */
function plainHits(words: string[]): string[] {
  const hits: string[] = []
  for (const file of [...filesUnder(WALNUT_HOME), ...filesUnder(LOG_DIR)]) {
    let bytes: Buffer
    try { bytes = fs.readFileSync(file) } catch { continue } // a temp file gone while the scan ran
    for (const w of words) {
      for (const needle of [Buffer.from(w, 'utf8'), Buffer.from(w.toLowerCase(), 'utf8'), Buffer.from(w, 'utf16le')]) {
        if (bytes.includes(needle)) { hits.push(`${path.relative(path.dirname(WALNUT_HOME), file)}: ${w}`); break }
      }
    }
  }
  return hits
}

/** Commit the data folder as git sync's auto-save does (a repo of its own when the test has none). */
function commitHome(message: string): void {
  const git = (...args: string[]) => execFileSync('git', ['-C', WALNUT_HOME, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'pipe' })
  if (!fs.existsSync(path.join(WALNUT_HOME, '.git'))) git('init', '-q')
  git('add', '-A', '--', notesRoot())
  git('commit', '-q', '--allow-empty', '-m', message)
}

/** Every git object of the data folder's history (they are compressed, so a byte scan misses them). */
function gitHits(words: string[]): string[] {
  const git = path.join(WALNUT_HOME, '.git')
  if (!fs.existsSync(git)) return []
  const out = execFileSync('git', ['-C', WALNUT_HOME, 'cat-file', '--batch-all-objects', '--batch'], { maxBuffer: 512 * 1024 * 1024 })
  return words.filter((w) => out.includes(Buffer.from(w, 'utf8')))
}

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  resetVaultForTest(null)
  resetSessionsForTest()
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  if (!stopped) await stopServer()
})

describe('a locked note on disk', () => {
  it('is a plain note first: written, indexed and found by search', async () => {
    expect((await http('PUT', `/api/notes-v2/content/${NOTE}`, { content: TEXT })).status).toBe(200)
    const found = await waitFor(() => http('GET', `/api/notes-v2/search?q=${SEARCH_WORD}&mode=string`), (r) => JSON.stringify(r.body).includes('Private week'))
    expect(JSON.stringify(found.body)).toContain('Private week')
    // The scan sees plain text where it is: it is not blind.
    expect(plainHits([BEFORE[0]]).length).toBeGreaterThan(0)
    // Git sync's auto-save commits it as it is. A lock never rewrites history: this old copy stays
    // in it until the person has the history rewritten (the documented limit).
    commitHome('before the lock')
    expect(gitHits([BEFORE[0]])).toEqual([BEFORE[0]])
  })

  it('after the lock, a sealed edit and an approved agent read, holds none of its words anywhere', async () => {
    const setup = await v1('POST', '/vault/setup', { passwordKey: toB64(await derivePasswordKey(MASTER, kdf)), kdf, agentsWhileAway: false, client: 'test' })
    expect(setup.status).toBe(200)
    session = setup.body.session.token
    expect((await v1('POST', '/vault/notes/lock', { path: NOTE })).status).toBe(200)

    // The person shows it and writes more, sealed.
    const cur = (await v1('POST', '/vault/notes/read', { path: NOTE })).body
    const next = `${cur.content}\nWednesday: ${AFTER[1]}. ${AFTER[0]}.\n`
    expect((await v1('POST', '/vault/notes/save', { path: NOTE, content: next, expectedHash: cur.contentHash })).status).toBe(200)

    // An agent reads it after the person's yes with the master password.
    const ask = (await v1('POST', '/vault/notes/agent/ask', { path: NOTE, purpose: 'summarise the week' }, AGENT)).body
    const card = (await http('GET', '/api/v1/approvals')).body.approvals.find((a: { id: string }) => a.id === ask.requestId)
    session = (await v1('POST', '/vault/unlock', { password: MASTER })).body.session.token
    expect((await v1('POST', `/approvals/${ask.requestId}/answer`, { decision: 'approve', digest: card.digest, device: { name: 'Web console', kind: 'web' } })).status).toBe(200)
    const got = (await v1('POST', `/vault/notes/agent/ask/${ask.requestId}/wait`, { token: ask.waitToken, wait_ms: 0 }, AGENT)).body
    expect(got.content).toContain(AFTER[0])

    // Search answers nothing for it any more, once the index caught up.
    const gone = await waitFor(() => http('GET', `/api/notes-v2/search?q=${SEARCH_WORD}&mode=string`), (r) => !JSON.stringify(r.body).includes('Private week'))
    expect(JSON.stringify(gone.body)).not.toContain('Private week')

    // An auto-save of the data folder after the lock holds only the ciphertext.
    commitHome('after the lock')
    expect(gitHits(AFTER)).toEqual([])

    // The indexes wiped what they freed; the server stops, then every byte is read.
    await settleLockedNoteResidue()
    await stopServer()
    stopped = true
    expect(fs.readFileSync(path.join(notesRoot(), NOTE), 'utf8')).toContain('walnut-locked-note v1')
    expect(plainHits([...BEFORE, ...AFTER, '\u4f60\u597d\u4e16\u754c'])).toEqual([])
    // Finished: no wipe is left for the next start.
    expect(fs.existsSync(wipePendingPath())).toBe(false)
  }, 120_000)
})
