/**
 * The 2026-11-21 benchmark comes in as comparison takes: A0 as the in-use
 * engine, whisper as Whisper large-v2, A3 as the Haiku clean-up, the silver
 * text as the reference, scored on the way in. Importing again changes
 * nothing, and a result Voice Accuracy made itself is never overwritten.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../src/constants.js', async () => (await import('../helpers/mock-constants.js')).createMockConstants('stt-compare-import'))

const { importBench, audioRefOfPath, BENCH_IMPORT } = await import('../../src/core/stt/compare/import-bench.js')
const { compareStore } = await import('../../src/core/stt/compare/store.js')

const PHONE = '0f67b10c-1111-4222-8333-444455556666'
const REC = '2026-11-10T04-19-04-803Z'
let dir = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bench-fixture-'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'takes.json'), JSON.stringify([
    { id: `rec-${REC}`, kind: 'macapp', audio: `/home/someone/.open-walnut/tmp/stt-recordings/${REC}.webm`, ts: '2026-11-10T04:19:04.805Z', dur: 28.7, text: 'deploy the pot now' },
    { id: 'phone-0f67b10c', kind: 'phone', audio: `/home/someone/.open-walnut/voice-archive/${PHONE}/audio`, ts: '2026-11-10T17:03:45.000Z', dur: 30.2, text: 'open the notes' },
    { id: 'rec-orphan', kind: 'web', audio: '/elsewhere/clip.webm', ts: '2026-11-10T00:00:00.000Z' },
  ]))
  await writeFile(join(dir, 'results.json'), JSON.stringify({ per_take: [
    { id: `rec-${REC}`, silver: 'deploy the pod now', terms: { pod: 1 }, texts: { A0: 'deploy the pot now', whisper: 'deploy the pod now', A3: 'deploy the pod now', A1: 'ignored' }, arms: { A0: { engine_ms: 1820 }, whisper: { engine_ms: 5481 }, A3: { llm_s: 4.97 } } },
    { id: 'phone-0f67b10c', silver: 'open the notes', terms: {}, texts: { A0: 'open the notes', whisper: 'open notes', A3: 'open the notes' }, arms: {} },
    { id: 'rec-orphan', silver: 'x', texts: { A0: 'x' } },
  ] }))
})

describe('importBench', () => {
  it('names the recording from its audio path', () => {
    expect(audioRefOfPath(`/a/voice-archive/${PHONE}/audio`)).toEqual({ kind: 'archive', id: PHONE })
    expect(audioRefOfPath(`/a/tmp/stt-recordings/${REC}.webm`)).toEqual({ kind: 'recording', id: REC })
    expect(audioRefOfPath('/a/clip.webm')).toBeNull()
  })

  it('maps the arms to engines, keeps the silver reference and scores it', async () => {
    const result = await importBench(dir)
    expect(result).toMatchObject({ imported: 2, unchanged: 0 })
    expect(result.skipped.map((s) => s.id)).toEqual(['rec-orphan'])
    const web = (await compareStore.get(`rec-${REC}`))!
    expect(web).toMatchObject({ source: 'web', format: 'webm', durationSec: 28.7, inUseText: 'deploy the pot now', imported: BENCH_IMPORT })
    expect(web.results['in-use']).toMatchObject({ text: 'deploy the pot now', ms: 1820, model: '11-21 benchmark' })
    expect(web.results['whisper-large-v2']).toMatchObject({ text: 'deploy the pod now', ms: 5481 })
    expect(web.results['haiku-cleanup']).toMatchObject({ ms: 4970 })
    expect(web.results.A1).toBeUndefined()
    expect(web.reference).toMatchObject({ text: 'deploy the pod now', judge: 'claude-opus-5-5 (11-21 benchmark)', terms: ['pod'] })
    expect(web.scores!['in-use']).toMatchObject({ edits: 1, n: 4, termsHit: 0, termsNeed: 1 })
    expect(web.scores!['whisper-large-v2']).toMatchObject({ edits: 0, termsHit: 1 })
    const phone = (await compareStore.get(`phone-${PHONE}`))!
    expect(phone).toMatchObject({ source: 'phone', audioRef: { kind: 'archive', id: PHONE } })
  })

  it('is idempotent', async () => {
    const before = await compareStore.all()
    expect(await importBench(dir)).toMatchObject({ imported: 0, unchanged: 2 })
    expect(await compareStore.all()).toEqual(before)
  })

  it('never overwrites a result Voice Accuracy made itself', async () => {
    const id = `rec-${REC}`
    // As if the entry existed before any import (made by a comparison run).
    await compareStore.upsert(id, { imported: undefined, results: { 'in-use': { text: 'heard live', ms: 5, at: 'now' } } })
    await importBench(dir)
    expect((await compareStore.get(id))!.results['in-use']!.text).toBe('heard live')
  })
})
