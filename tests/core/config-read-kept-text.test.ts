/**
 * readConfigSnapshot reads config.yaml's bytes again only when the file's identity moved
 * (src/core/config-file-io.ts keptText). getConfig runs some 20 times a second on the live server
 * and every read made a 25 KB buffer and a 50 KB string of the same bytes (2026-11-25, the memory
 * bursts after a start). A file that changed recently is read every time; any write moves the
 * identity (size, mtime, ctime, inode), so an edit is never missed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _forgetKeptConfigTextForTesting, readConfigSnapshot } from '../../src/core/config-file-io.js'

/** The settle window, shortened for the test (the real one is 2 s). */
const SETTLED_MS = 150

let dir: string
let file: string
let byteReads = 0

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-kept-text-'))
  file = path.join(dir, 'config.yaml')
  _forgetKeptConfigTextForTesting(SETTLED_MS)
  byteReads = 0
  const realOpen = fs.open.bind(fs)
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const fh = await realOpen(...args)
    const realRead = fh.readFile.bind(fh)
    fh.readFile = ((...a: Parameters<typeof fh.readFile>) => { byteReads++; return realRead(...a) }) as typeof fh.readFile
    return fh
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  _forgetKeptConfigTextForTesting()
  await fs.rm(dir, { recursive: true, force: true })
})

const AN_HOUR_AGO = new Date(Date.now() - 3_600_000)

/** Write `text` dated an hour back (its ctime stays now: only the kernel sets that). */
async function writeAged(text: string): Promise<void> {
  await fs.writeFile(file, text, 'utf-8')
  await fs.utimes(file, AN_HOUR_AGO, AN_HOUR_AGO)
}

/** Wait out the settle window, so the file's ctime (now at the write) is old too, as an untouched file's is. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, SETTLED_MS + 50))
}

describe('readConfigSnapshot keeps the text of an unchanged file', () => {
  it('reads the bytes once for many reads of a settled file', async () => {
    await writeAged('agent:\n  name: one\nnote: "\\u00e9t\\u00e9"\n')
    await settle()
    for (let i = 0; i < 25; i++) {
      const snap = await readConfigSnapshot(file)
      expect(snap.state).toBe('ok')
      expect(snap.changing).toBe(false)
      expect((snap.doc!.agent as { name: string }).name).toBe('one')
    }
    // Old code: 25.
    expect(byteReads).toBe(1)
  })

  it('a file changed in the last moments is read every time', async () => {
    await fs.writeFile(file, 'a: 1\n', 'utf-8')
    for (let i = 0; i < 3; i++) expect((await readConfigSnapshot(file)).doc).toEqual({ a: 1 })
    expect(byteReads).toBe(3)
  })

  it('an edit of the same size dated back to the same mtime is still read', async () => {
    await writeAged('a: 1\n')
    await settle()
    expect((await readConfigSnapshot(file)).doc).toEqual({ a: 1 })
    expect((await readConfigSnapshot(file)).doc).toEqual({ a: 1 })
    expect(byteReads).toBe(1)
    const first = await fs.stat(file)
    // Same size, same mtime: only its ctime says it changed.
    await writeAged('a: 2\n')
    const second = await fs.stat(file)
    expect([second.size, second.mtimeMs]).toEqual([first.size, first.mtimeMs])
    expect((await readConfigSnapshot(file)).doc).toEqual({ a: 2 })
    expect(byteReads).toBe(2)
  })

  it('a file replaced by rename is read again', async () => {
    await writeAged('a: 1\n')
    await settle()
    await readConfigSnapshot(file)
    const tmp = path.join(dir, 'next.yaml')
    await fs.writeFile(tmp, 'a: 3\n', 'utf-8')
    await fs.utimes(tmp, AN_HOUR_AGO, AN_HOUR_AGO)
    await fs.rename(tmp, file)
    expect((await readConfigSnapshot(file)).doc).toEqual({ a: 3 })
    expect(byteReads).toBe(2)
  })

  it('a file that went away reads as missing, and one that comes back is read', async () => {
    await writeAged('a: 1\n')
    await settle()
    await readConfigSnapshot(file)
    await fs.rm(file)
    expect((await readConfigSnapshot(file)).state).toBe('missing')
    await writeAged('a: 1\n')
    expect((await readConfigSnapshot(file)).doc).toEqual({ a: 1 })
    expect(byteReads).toBe(2)
  })
})

/**
 * The config is read through readConfigSnapshot, which keeps the text above. The few direct reads
 * of the file's bytes are listed (a replica copy of it, the diagnostics probe): each reads fresh and
 * rarely. A new one in a hot path would pay the buffer and the string again on every call.
 */
describe('ratchet: config.yaml is read through readConfigSnapshot', () => {
  it('no file in src/ reads its bytes directly, except the listed ones', async () => {
    const root = path.resolve(__dirname, '../..')
    const found: string[] = []
    const walk = async (d: string): Promise<void> => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) { await walk(p); continue }
        if (!/\.tsx?$/.test(e.name)) continue
        if (/(?:readFile(?:Sync)?|readText|readConfigReadOnly)\(\s*CONFIG_FILE\b/.test(await fs.readFile(p, 'utf8'))) found.push(path.relative(root, p))
      }
    }
    await walk(path.join(root, 'src'))
    expect(found.sort()).toEqual(['src/core/diagnostics/probes.ts', 'src/core/replication/kinds/config.ts'])
  })
})
