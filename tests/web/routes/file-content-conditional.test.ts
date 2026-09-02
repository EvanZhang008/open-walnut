/**
 * Conditional GET on GET /api/file-content — the "re-opening an unchanged file
 * ships ZERO bytes" contract, through the real express edge.
 *
 * What each block pins, one line each:
 *   - a complete text 200 advertises its `contentHash` as an ETag + no-cache,
 *   - a matching If-None-Match answers 304 with an EMPTY body and the same ETag,
 *   - the 304 is decided from a stat alone: the file's bytes are never read
 *     (proved by swapping the content behind a pinned mtime+size),
 *   - changed bytes answer 200 with the NEW ETag,
 *   - a truncated or binary read never advertises an ETag and never 304s,
 *   - If-None-Match parsing: weak `W/`, lists, whitespace, `*`, and malformed
 *     values that must degrade to 200 rather than guess,
 *   - `?track=` recording lands exactly as it does on a 200,
 *   - the validator cache stays bounded,
 *   - the path sandbox runs BEFORE any stat.
 *
 * SAFETY: every path written here lives under the mkdtemp directories created in
 * beforeEach, and OPEN_WALNUT_HOME is repointed at one of them so the file
 * history store is isolated too.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import express from 'express'
import request from 'supertest'

const { fileContentRouter } = await import('../../../src/web/routes/file-content.js')
const {
  clearFileValidatorCache,
  fileValidatorCacheSize,
  peekFileValidator,
  rememberFileValidator,
  parseIfNoneMatch,
} = await import('../../../src/web/routes/file-content-validator.js')
const { listSnapshots, recordSnapshot } = await import('../../../src/core/file-history.js')
const { errorHandler } = await import('../../../src/web/middleware/error-handler.js')

function createApp() {
  const app = express()
  // Mirror the real server (server.ts `app.set('etag', false)`): Express would
  // otherwise stamp its own weak ETag on every JSON body, which is exactly the
  // blind API caching that route was turned off for — and it would mask whether
  // THIS route advertised a validator of its own.
  app.set('etag', false)
  app.use(express.json())
  app.use('/api/file-content', fileContentRouter)
  app.use(errorHandler)
  return app
}

let work: string
let tmpHome: string
let prevHome: string | undefined
let app: express.Express

const at = (rel: string) => path.join(work, rel)

/** A plain read — this is what publishes the validator for the next request. */
const read = (filePath: string, extra: Record<string, string> = {}) =>
  request(app).get('/api/file-content').query({ path: filePath, ...extra })

/** A conditional read. */
const revalidate = (filePath: string, inm: string, extra: Record<string, string> = {}) =>
  request(app).get('/api/file-content').query({ path: filePath, ...extra }).set('If-None-Match', inm)

/** Read once and hand back the ETag the client would keep. */
async function prime(filePath: string, extra: Record<string, string> = {}): Promise<string> {
  const res = await read(filePath, extra)
  expect(res.status).toBe(200)
  expect(res.body.contentHash).toMatch(/^[0-9a-f]{12}$/)
  return res.body.contentHash as string
}

/** Recording is fire-and-forget by design, so poll instead of sleeping. */
async function historyWith(filePath: string, minEntries: number) {
  const deadline = Date.now() + 2_000
  let entries = await listSnapshots({ path: filePath })
  while (entries.length < minEntries && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
    entries = await listSnapshots({ path: filePath })
  }
  return entries
}

beforeEach(async () => {
  prevHome = process.env.OPEN_WALNUT_HOME
  work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-fcc-work-')))
  tmpHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-fcc-home-')))
  process.env.OPEN_WALNUT_HOME = tmpHome
  clearFileValidatorCache()
  app = createApp()
  await fs.writeFile(at('notes.txt'), 'hello walnut\n', 'utf-8')
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.OPEN_WALNUT_HOME
  else process.env.OPEN_WALNUT_HOME = prevHome
  clearFileValidatorCache()
  // Both are mkdtemp dirs from beforeEach — nothing else is removed.
  await fs.rm(work, { recursive: true, force: true })
  await fs.rm(tmpHome, { recursive: true, force: true })
})

describe('GET /api/file-content — the ETag it hands out', () => {
  it('advertises the payload contentHash as the ETag, with no-cache', async () => {
    const res = await read(at('notes.txt'))
    expect(res.status).toBe(200)
    expect(res.headers.etag).toBe(`"${res.body.contentHash}"`)
    expect(res.headers['cache-control']).toBe('no-cache')
    // The JSON shape is untouched by any of this.
    expect(res.body.content).toBe('hello walnut\n')
    expect(res.body.truncated).toBe(false)
    expect(res.body.binary).toBe(false)
  })

  it('a request WITHOUT If-None-Match always gets the full body, even when cached', async () => {
    await prime(at('notes.txt'))
    const res = await read(at('notes.txt'))
    expect(res.status).toBe(200)
    expect(res.body.content).toBe('hello walnut\n')
  })
})

describe('GET /api/file-content — 304 on an unchanged file', () => {
  it('answers 304 with an EMPTY body and the same ETag + Cache-Control', async () => {
    const file = at('notes.txt')
    const tag = await prime(file)

    const res = await revalidate(file, `"${tag}"`)
    expect(res.status).toBe(304)
    expect(res.headers.etag).toBe(`"${tag}"`)
    expect(res.headers['cache-control']).toBe('no-cache')
    expect(res.text ?? '').toBe('')
    expect(res.body).toEqual({})
  })

  it('decides the 304 from a stat alone — the bytes are never read', async () => {
    // The proof: pin mtime+size, prime, then swap in DIFFERENT bytes of the same
    // length behind the same pinned mtime. A 304 quoting the OLD hash can only
    // mean the file was not read. (It is also the documented weak-validator
    // trade-off: mtime+size equal ⇒ treated as unchanged. A save is protected
    // independently by the expectedHash optimistic lock, so a stale read cannot
    // clobber anything — it 409s.)
    const file = at('pinned.txt')
    const pinned = new Date(1767225600000) // whole second → mtimeMs is exact
    await fs.writeFile(file, 'AAAAAAAAAA', 'utf-8')
    await fs.utimes(file, pinned, pinned)
    const tag = await prime(file)

    await fs.writeFile(file, 'BBBBBBBBBB', 'utf-8') // same length, different bytes
    await fs.utimes(file, pinned, pinned)
    expect(await fs.readFile(file, 'utf-8')).toBe('BBBBBBBBBB') // really changed

    const res = await revalidate(file, `"${tag}"`)
    expect(res.status).toBe(304)
    expect(res.headers.etag).toBe(`"${tag}"`) // the OLD hash — nothing was hashed
    expect(res.text ?? '').toBe('')
  })

  it('a 304 for one file does not leak to another path with the same hash', async () => {
    const a = at('a.txt')
    const b = at('b.txt')
    await fs.writeFile(a, 'same bytes\n', 'utf-8')
    await fs.writeFile(b, 'same bytes\n', 'utf-8')
    const tag = await prime(a)
    // b was never read, so there is nothing to validate against — full 200.
    const res = await revalidate(b, `"${tag}"`)
    expect(res.status).toBe(200)
    expect(res.body.content).toBe('same bytes\n')
    expect(res.headers.etag).toBe(`"${tag}"`)
  })
})

describe('GET /api/file-content — changed bytes', () => {
  it('answers 200 with the new content and a NEW ETag', async () => {
    const file = at('notes.txt')
    const oldTag = await prime(file)

    await fs.writeFile(file, 'a whole new line of text\n', 'utf-8')
    const res = await revalidate(file, `"${oldTag}"`)
    expect(res.status).toBe(200)
    expect(res.body.content).toBe('a whole new line of text\n')
    expect(res.body.contentHash).not.toBe(oldTag)
    expect(res.headers.etag).toBe(`"${res.body.contentHash}"`)

    // …and the new tag now revalidates.
    const again = await revalidate(file, res.headers.etag as string)
    expect(again.status).toBe(304)
  })

  it('a missing file answers the legacy error payload, never a 304', async () => {
    const file = at('vanishes.txt')
    await fs.writeFile(file, 'here for now\n', 'utf-8')
    const tag = await prime(file)
    await fs.rm(file)

    const res = await revalidate(file, `"${tag}"`)
    expect(res.status).toBe(200)
    expect(res.body.error).toBe('File not found')
    expect(res.headers.etag).toBeUndefined()
  })
})

describe('GET /api/file-content — payloads that must never 304', () => {
  it('a truncated read advertises no ETag and stays 200 under any validator', async () => {
    const big = at('big.txt')
    await fs.writeFile(big, 'x'.repeat(600 * 1024), 'utf-8')

    const first = await read(big)
    expect(first.status).toBe(200)
    expect(first.body.truncated).toBe(true)
    expect(first.body.contentHash).toBeUndefined()
    expect(first.headers.etag).toBeUndefined()

    // Nothing was remembered, so even a wildcard cannot shortcut it.
    for (const inm of ['"abcabcabcabc"', '*']) {
      const res = await revalidate(big, inm)
      expect(res.status).toBe(200)
      expect(res.body.truncated).toBe(true)
      expect(res.headers.etag).toBeUndefined()
    }
  })

  it('a binary file advertises no ETag and stays 200 under any validator', async () => {
    const bin = at('blob.bin')
    const bytes = Buffer.alloc(4096)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251 // includes NULs
    await fs.writeFile(bin, bytes)

    const first = await read(bin)
    expect(first.status).toBe(200)
    expect(first.body.binary).toBe(true)
    expect(first.headers.etag).toBeUndefined()

    for (const inm of ['"abcabcabcabc"', '*']) {
      const res = await revalidate(bin, inm)
      expect(res.status).toBe(200)
      expect(res.body.binary).toBe(true)
      expect(res.headers.etag).toBeUndefined()
    }
  })
})

describe('GET /api/file-content — If-None-Match forms', () => {
  it('accepts the weak form, a list, surrounding whitespace, and a bare token', async () => {
    const file = at('notes.txt')
    const tag = await prime(file)
    const accepted = [
      `"${tag}"`,
      `W/"${tag}"`,
      `"nope-nope-no", "${tag}"`,
      `  "${tag}"  `,
      `W/"other-tag-01", W/"${tag}"`,
      tag, // unquoted: sloppy, but it can only match the real hash
      '*', // RFC 9110 wildcard, against a file we HAVE validated
    ]
    for (const inm of accepted) {
      const res = await revalidate(file, inm)
      expect(res.status, `If-None-Match: ${inm}`).toBe(304)
      expect(res.headers.etag).toBe(`"${tag}"`)
    }
  })

  it('falls back to 200 for a non-matching, empty, malformed, or mixed-wildcard value', async () => {
    const file = at('notes.txt')
    const tag = await prime(file)
    const rejected = [
      '"000000000000"', // a real tag, just not ours
      `"${tag}`, // half-quoted → malformed, do not guess
      `${tag}"`, // half-quoted the other way
      '""', // empty tag matches nothing real
      ' , ', // no tags at all
      `*, "${tag}"`, // `*` must stand alone (RFC 9110)
      `"${tag}" "${tag}"`, // space-separated, not a list
    ]
    for (const inm of rejected) {
      const res = await revalidate(file, inm)
      expect(res.status, `If-None-Match: ${inm}`).toBe(200)
      expect(res.body.content).toBe('hello walnut\n')
      expect(res.headers.etag).toBe(`"${tag}"`)
    }
  })

  it('parseIfNoneMatch reports malformed as null rather than an empty match set', () => {
    expect(parseIfNoneMatch(undefined)).toBeNull()
    expect(parseIfNoneMatch('')).toBeNull()
    expect(parseIfNoneMatch('  ')).toBeNull()
    expect(parseIfNoneMatch('""')).toBeNull()
    expect(parseIfNoneMatch('"a", *')).toBeNull()
    expect(parseIfNoneMatch('"abc')).toBeNull()
    expect(parseIfNoneMatch(['"abc"'])).toBeNull() // duplicated header array → don't guess
    expect(parseIfNoneMatch('*')).toEqual({ wildcard: true, tags: [] })
    expect(parseIfNoneMatch('W/"abc"')).toEqual({ wildcard: false, tags: ['abc'] })
    expect(parseIfNoneMatch('"a", W/"b"')).toEqual({ wildcard: false, tags: ['a', 'b'] })
  })
})

describe('GET /api/file-content — ?track= on a 304', () => {
  it('leaves the timeline exactly as a 200 would: the no-op stays a no-op', async () => {
    const file = at('opened.ts')
    await fs.writeFile(file, 'export const x = 1\n', 'utf-8')

    const tag = await prime(file, { track: 'baseline' })
    const first = await historyWith(file, 1)
    expect(first.map((e) => e.writer)).toEqual(['baseline'])
    expect(first[0].hash).toBe(tag)

    // Re-opening the same unchanged file: 304, and the timeline is unchanged —
    // which is precisely what recordSnapshot would have done with the content.
    const res = await revalidate(file, `"${tag}"`, { track: 'baseline' })
    expect(res.status).toBe(304)
    await new Promise((r) => setTimeout(r, 50))
    const after = await listSnapshots({ path: file })
    expect(after.map((e) => e.hash)).toEqual([tag])
  })

  it('does the real recording (200) when it would NOT be a no-op', async () => {
    const file = at('opened2.ts')
    await fs.writeFile(file, 'export const y = 2\n', 'utf-8')
    const tag = await prime(file) // validator cached, no history yet

    // Someone else's version now sits at the head of the timeline, so a tracked
    // 200 WOULD record — a 304 may not stand in for it.
    await recordSnapshot({ path: file, content: 'a different version\n', writer: 'user' })
    expect((await listSnapshots({ path: file })).length).toBe(1)

    const res = await revalidate(file, `"${tag}"`, { track: 'baseline' })
    expect(res.status).toBe(200)
    expect(res.body.content).toBe('export const y = 2\n')

    const entries = await historyWith(file, 2)
    expect(entries.length).toBe(2)
    expect(entries[1].writer).toBe('baseline')
    expect(entries[1].hash).toBe(tag)

    // Now the recording IS a no-op, so the steady state is back to zero bytes.
    const again = await revalidate(file, `"${tag}"`, { track: 'baseline' })
    expect(again.status).toBe(304)
  })

  it('a tracked read of an untracked file still records, then 304s next time', async () => {
    const file = at('opened3.ts')
    await fs.writeFile(file, 'export const z = 3\n', 'utf-8')
    const tag = await prime(file) // no track → no history

    const res = await revalidate(file, `"${tag}"`, { track: 'agent' })
    expect(res.status).toBe(200) // history is empty: recording is not a no-op
    const entries = await historyWith(file, 1)
    expect(entries.map((e) => e.writer)).toEqual(['agent'])

    expect((await revalidate(file, `"${tag}"`, { track: 'agent' })).status).toBe(304)
  })
})

describe('GET /api/file-content — the sandbox still runs first', () => {
  it('refuses a traversal path on a conditional request (400, not 304)', async () => {
    const res = await revalidate(work + '/../notes.txt', '*')
    expect(res.status).toBe(400)
  })

  it('refuses a relative path on a conditional request', async () => {
    const res = await revalidate('relative/notes.txt', '*')
    expect(res.status).toBe(400)
  })
})

describe('the validator cache stays bounded', () => {
  it('caps at 2000 entries and evicts the oldest first', async () => {
    clearFileValidatorCache()
    for (let i = 0; i < 2500; i++) {
      rememberFileValidator(undefined, `/tmp/no-such-dir/f${i}.txt`, {
        mtimeMs: i, size: i, hash: 'h'.repeat(12),
      })
    }
    expect(fileValidatorCacheSize()).toBe(2000)
    expect(peekFileValidator(undefined, '/tmp/no-such-dir/f0.txt')).toBeUndefined()
    expect(peekFileValidator(undefined, '/tmp/no-such-dir/f499.txt')).toBeUndefined()
    expect(peekFileValidator(undefined, '/tmp/no-such-dir/f500.txt')).toBeDefined()
    expect(peekFileValidator(undefined, '/tmp/no-such-dir/f2499.txt')).toBeDefined()
  })

  it('keys on (host, path) so the same path on two hosts cannot collide', () => {
    clearFileValidatorCache()
    const p = '/home/example/project/main.ts'
    rememberFileValidator(undefined, p, { mtimeMs: 1, size: 1, hash: 'local-hash-0' })
    rememberFileValidator('build-box', p, { mtimeMs: 2, size: 2, hash: 'remote-hash' })
    expect(peekFileValidator(undefined, p)?.hash).toBe('local-hash-0')
    expect(peekFileValidator('build-box', p)?.hash).toBe('remote-hash')
    expect(fileValidatorCacheSize()).toBe(2)
  })
})
