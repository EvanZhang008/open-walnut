/**
 * The comparison store: one JSON per take, merged per engine, newest first
 * with a cursor, at most 500 entries (the one touched longest ago goes, never
 * the one just written), written whole, and cleared whole.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CompareStore, MAX_TAKES, takeIdOf, validTakeId } from '../../src/core/stt/compare/store.js'

let dir: string
let store: CompareStore
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'stt-compare-store-'))
  store = new CompareStore(async () => join(dir, 'takes'))
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const base = (at: string) => ({ source: 'web' as const, at, format: 'webm', audioRef: { kind: 'recording' as const, id: 'x' } })

describe('CompareStore', () => {
  it('ids name the recording and refuse anything else', () => {
    expect(takeIdOf({ kind: 'recording', id: '2026-11-21T01-02-03-004Z' })).toBe('rec-2026-11-21T01-02-03-004Z')
    expect(takeIdOf({ kind: 'archive', id: '0f67b10c-0000-4000-8000-000000000000' })).toBe('phone-0f67b10c-0000-4000-8000-000000000000')
    expect(validTakeId('rec-../../etc')).toBe(false)
    expect(validTakeId('other-1')).toBe(false)
  })

  it('merges results per engine and keeps the rest', async () => {
    await store.upsert('rec-a', { ...base('2026-11-21T00:00:00.000Z'), results: { 'in-use': { text: 'one', ms: 1, at: 'a' } } })
    await store.upsert('rec-a', { results: { whisper: { error: 'boom', ms: 2, at: 'b' } }, sentText: 'sent' })
    const take = await store.get('rec-a')
    expect(Object.keys(take!.results).sort()).toEqual(['in-use', 'whisper'])
    expect(take!.sentText).toBe('sent')
    // On disk, whole, and read back by a fresh store.
    const onDisk = JSON.parse(await readFile(join(dir, 'takes', 'rec-a.json'), 'utf8'))
    expect(onDisk.results['in-use'].text).toBe('one')
    expect((await readdir(join(dir, 'takes'))).filter((f) => f.endsWith('.tmp'))).toEqual([])
    const fresh = new CompareStore(async () => join(dir, 'takes'))
    expect((await fresh.get('rec-a'))!.results.whisper!.error).toBe('boom')
  })

  it('refuses a new entry without its source', async () => {
    await expect(store.upsert('rec-b', { sentText: 'x' })).rejects.toThrow(/lacks its source/)
  })

  it('lists newest first, a page at a time', async () => {
    for (let i = 0; i < 5; i++) await store.upsert(`rec-t${i}`, base(`2026-11-2${i}T00:00:00.000Z`))
    const first = await store.list(2)
    expect(first.takes.map((t) => t.id)).toEqual(['rec-t4', 'rec-t3'])
    const second = await store.list(2, first.nextCursor)
    expect(second.takes.map((t) => t.id)).toEqual(['rec-t2', 'rec-t1'])
    const third = await store.list(2, second.nextCursor)
    expect(third.takes.map((t) => t.id)).toEqual(['rec-t0'])
    expect(third.nextCursor).toBeUndefined()
  })

  it(`keeps at most ${MAX_TAKES} takes, dropping the oldest`, async () => {
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()
    await Promise.all(Array.from({ length: MAX_TAKES + 2 }, (_, i) => store.upsert(`rec-n${i}`, base(at(i)))))
    expect(await store.count()).toBe(MAX_TAKES)
    expect(await store.has('rec-n0')).toBe(false)
    expect(await store.has('rec-n1')).toBe(false)
    expect(await store.has(`rec-n${MAX_TAKES + 1}`)).toBe(true)
    expect((await readdir(join(dir, 'takes'))).length).toBe(MAX_TAKES)
  })

  it('a new entry older than all the others is kept (and can be written again); the least touched goes', async () => {
    const at = (i: number) => new Date(Date.UTC(2026, 0, 2) + i * 60_000).toISOString()
    for (let i = 0; i < MAX_TAKES; i++) await store.upsert(`rec-m${i}`, base(at(i)))
    // A take from before every one stored (an old recording compared now).
    await store.upsert('rec-old', base('2025-01-01T00:00:00.000Z'))
    expect(await store.has('rec-old')).toBe(true)
    await expect(store.upsert('rec-old', { results: { 'in-use': { text: 'x', ms: 1, at: 'a' } } })).resolves.toMatchObject({ id: 'rec-old' })
    expect(await store.has('rec-m0')).toBe(false)
    expect(await store.count()).toBe(MAX_TAKES)
  })

  it('clear removes every entry and its folder', async () => {
    await store.upsert('rec-c', base('2026-11-21T00:00:00.000Z'))
    await store.clear()
    expect(await store.count()).toBe(0)
    await expect(readdir(join(dir, 'takes'))).rejects.toThrow()
  })
})
