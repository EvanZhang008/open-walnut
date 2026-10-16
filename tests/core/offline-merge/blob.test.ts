/**
 * fetchOfflineBlob (src/core/offline-merge/blob.ts) against the REAL daemon journal core's
 * readBlob (offline-journal-core.ts, the code both daemon twins inline), in a temp dir:
 * a body larger than one 2 MB chunk comes back whole and checked; a missing body and a
 * body whose bytes do not match the sha are refused.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fetchOfflineBlob } from '../../../src/core/offline-merge/blob.js'
import { createOfflineJournal } from '../../../src/providers/offline-journal-core.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-blob-'))
fs.chmodSync(dir, 0o700)
const journal = createOfflineJournal({ fs, path, dir, now: () => Date.now(), log: () => {}, randomHex: (n: number) => crypto.randomBytes(n).toString('hex'), keyOf: (h: string) => crypto.createHash('sha256').update(h).digest('hex').slice(0, 16), pid: process.pid })

function put(body: Buffer): string {
  const sha = crypto.createHash('sha256').update(body).digest('hex')
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'blobs', sha), body)
  return sha
}

const conn = {
  calls: 0,
  async send(cmd: string, params: Record<string, unknown> = {}) {
    this.calls++
    if (cmd !== 'offline.blob') return { ok: false, error: 'unknown' }
    const r = journal.readBlob(params.sha, params.offset) as Record<string, unknown>
    return r.ok ? r : { ok: false, error: r.message }
  },
}

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('offline.blob fetch', () => {
  it('a body over one chunk comes back whole, checked against its sha', async () => {
    const body = crypto.randomBytes(5 * 1024 * 1024 + 17)
    const sha = put(body)
    conn.calls = 0
    const got = await fetchOfflineBlob(conn, sha)
    expect(got.equals(body)).toBe(true)
    expect(conn.calls).toBe(3)
  })

  it('a missing body and a body that does not match its sha are refused', async () => {
    await expect(fetchOfflineBlob(conn, 'a'.repeat(64))).rejects.toThrow(/does not hold/)
    const sha = put(Buffer.from('original note body\n'))
    fs.writeFileSync(path.join(dir, 'blobs', sha), 'tampered note body\n')
    await expect(fetchOfflineBlob(conn, sha)).rejects.toThrow(/does not match/)
  })
})
