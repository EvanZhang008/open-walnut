/**
 * A drawing's walkthrough file on disk (src/core/drawings/narration-store.ts) in a real vault:
 * a take is saved and replaced by its id, two saves at once both keep their takes, a file this
 * version cannot read is never overwritten, the file follows a rename and goes with a delete,
 * and the AI's answer (overview, then detail) reads the drawing's current labels.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('drawings-narration'))

import { NOTES_DIR } from '../../../src/constants.js'
import { createDrawing, readDrawing, renameDrawing, writeDrawing, type DrawingDoc } from '../../../src/core/drawings/store.js'
import { deleteNarration, moveNarration, narrationAnswer, readNarration, saveNarrationTake } from '../../../src/core/drawings/narration-store.js'
import { DrawingInputError } from '../../../src/core/drawings/scene.js'

const vault = (rel: string) => path.join(NOTES_DIR, ...rel.split('/'))
const take = (id: string, text = 'the orders table is the core table', at = '2026-11-20T00:00:00Z') => ({
  id, startedAt: at, durationMs: 10_000,
  speech: [{ t0: 1_000, t1: 3_000, text }],
  events: [{ t: 500, kind: 'point', ids: ['box'], labels: ['orders'], untilT: 3_500 }],
})

async function refusal(p: Promise<unknown>): Promise<DrawingInputError> {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(DrawingInputError)
  return err as DrawingInputError
}

async function newDrawing(title: string): Promise<DrawingDoc> {
  const doc = await createDrawing({ title })
  const scene = {
    ...doc.scene,
    elements: [
      { id: 'box', type: 'rectangle', x: 0, y: 0, width: 100, height: 60, version: 1, versionNonce: 1, isDeleted: false, boundElements: [{ id: 'box-t', type: 'text' }] },
      { id: 'box-t', type: 'text', x: 10, y: 10, width: 60, height: 20, version: 1, versionNonce: 1, isDeleted: false, text: 'orders', originalText: 'orders', containerId: 'box' },
    ],
  }
  return writeDrawing(doc.path, doc.revision, scene)
}

beforeAll(async () => {
  await fs.mkdir(NOTES_DIR, { recursive: true })
})

describe('saving takes', () => {
  it('keeps a take beside the drawing and replaces it by id as it grows', async () => {
    const doc = await newDrawing('Shop design')
    expect(await saveNarrationTake(doc.path, take('t1', 'first words'))).toEqual({ takes: 1 })
    expect(await saveNarrationTake(doc.path, take('t1', 'first words, and more'))).toEqual({ takes: 1 })
    expect(await saveNarrationTake(doc.path, take('t2'))).toEqual({ takes: 2 })
    const onDisk = JSON.parse(await fs.readFile(vault(doc.path.replace(/\.excalidraw$/, '.narration.json')), 'utf-8'))
    expect(onDisk.scene).toBe(doc.path)
    expect(onDisk.takes.map((t: { speech: Array<{ text: string }> }) => t.speech[0].text)).toEqual(['first words, and more', 'the orders table is the core table'])
    // The drawing itself is untouched: its revision is the same.
    expect((await readDrawing(doc.path) as DrawingDoc).revision).toBe(doc.revision)
  })

  it('keeps both takes when two windows save at once', async () => {
    const doc = await newDrawing('Two windows')
    await Promise.all(Array.from({ length: 8 }, (_, i) => saveNarrationTake(doc.path, take(`w${i}`))))
    expect((await readNarration(doc.path)).map((t) => t.id).sort()).toEqual(['w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'])
  })

  it('refuses a drawing that does not exist, and a bad take', async () => {
    expect((await refusal(saveNarrationTake('inbox/Nope.excalidraw', take('x')))).status).toBe(404)
    const doc = await newDrawing('Bad take')
    expect((await refusal(saveNarrationTake(doc.path, { id: '' }))).status).toBe(400)
    expect((await refusal(saveNarrationTake('../outside.excalidraw', take('x')))).status).toBe(400)
  })

  it('never overwrites a file it cannot read, and keeps takes a newer version wrote', async () => {
    const doc = await newDrawing('Hand edited')
    const file = vault(doc.path.replace(/\.excalidraw$/, '.narration.json'))
    await fs.writeFile(file, '{ not json')
    expect((await refusal(saveNarrationTake(doc.path, take('x')))).status).toBe(409)
    expect(await fs.readFile(file, 'utf-8')).toBe('{ not json')
    expect(await readNarration(doc.path)).toEqual([])
    const future = { id: 'future', startedAt: 'someday', hologram: true }
    await fs.writeFile(file, JSON.stringify({ version: 2, scene: doc.path, takes: [future] }))
    await saveNarrationTake(doc.path, take('now'))
    const kept = JSON.parse(await fs.readFile(file, 'utf-8'))
    expect(kept.version).toBe(2)
    expect(kept.takes[0]).toEqual(future)
    expect(kept.takes).toHaveLength(2)
  })
})

describe('following the drawing', () => {
  it('moves with a rename and goes with a delete', async () => {
    const doc = await newDrawing('Before rename')
    await saveNarrationTake(doc.path, take('t1'))
    const renamed = await renameDrawing(doc.path, doc.revision, 'After rename')
    expect(renamed.path).toBe('inbox/After rename.excalidraw')
    expect(await readNarration(doc.path)).toEqual([])
    expect((await readNarration(renamed.path)).map((t) => t.id)).toEqual(['t1'])
    const moved = JSON.parse(await fs.readFile(vault('inbox/After rename.narration.json'), 'utf-8'))
    expect(moved.scene).toBe(renamed.path)
    expect(await deleteNarration(renamed.path)).toBe(true)
    await expect(fs.stat(vault('inbox/After rename.narration.json'))).rejects.toThrow()
  })

  it('leaves a file that is not this drawing\'s, and one already at the new place', async () => {
    const a = await newDrawing('Copy source')
    await saveNarrationTake(a.path, take('mine'))
    const file = vault(a.path.replace(/\.excalidraw$/, '.narration.json'))
    const raw = JSON.parse(await fs.readFile(file, 'utf-8'))
    await fs.writeFile(file, JSON.stringify({ ...raw, scene: 'elsewhere/Other.excalidraw' }))
    expect(await deleteNarration(a.path)).toBe(false)
    expect(await moveNarration(a.path, 'inbox/Somewhere.excalidraw')).toBe(false)
    await fs.writeFile(file, JSON.stringify(raw))
    await fs.writeFile(vault('inbox/Taken.narration.json'), '{}')
    expect(await moveNarration(a.path, 'inbox/Taken.excalidraw')).toBe(false)
    expect(await fs.readFile(vault('inbox/Taken.narration.json'), 'utf-8')).toBe('{}')
  })
})

describe('a file left behind or belonging to another drawing', () => {
  it('is never read as this drawing\'s, refused when its drawing exists, and replaced when that drawing is gone', async () => {
    const other = await newDrawing('Other drawing')
    const mine = await newDrawing('Mine')
    const file = vault(mine.path.replace(/\.excalidraw$/, '.narration.json'))
    await fs.writeFile(file, JSON.stringify({ version: 1, scene: other.path, takes: [take('theirs')] }))
    expect(await readNarration(mine.path)).toEqual([])
    expect((await refusal(saveNarrationTake(mine.path, take('m1')))).status).toBe(409)
    await fs.writeFile(file, JSON.stringify({ version: 1, scene: 'inbox/Long gone.excalidraw', takes: [take('ghost')] }))
    expect(await saveNarrationTake(mine.path, take('m1'))).toEqual({ takes: 1 })
    expect((await readNarration(mine.path)).map((t) => t.id)).toEqual(['m1'])
  })

  it('a rename onto a name with a leftover file takes its own takes along and leaves nothing behind', async () => {
    const doc = await newDrawing('Moving in')
    await saveNarrationTake(doc.path, take('mine'))
    await fs.writeFile(vault('inbox/New home.narration.json'), JSON.stringify({ version: 1, scene: 'inbox/Gone.excalidraw', takes: [take('ghost')] }))
    const renamed = await renameDrawing(doc.path, doc.revision, 'New home')
    expect(renamed.path).toBe('inbox/New home.excalidraw')
    expect((await readNarration(renamed.path)).map((t) => t.id)).toEqual(['mine'])
    await expect(fs.stat(vault('inbox/Moving in.narration.json'))).rejects.toThrow()
  })

  it('a save after the drawing was deleted makes no file at the old name', async () => {
    const doc = await newDrawing('Deleted meanwhile')
    await fs.unlink(vault(doc.path))
    expect((await refusal(saveNarrationTake(doc.path, take('late')))).status).toBe(404)
    await expect(fs.stat(vault('inbox/Deleted meanwhile.narration.json'))).rejects.toThrow()
  })
})

describe('what the AI reads', () => {
  it('answers the overview by default and a part in detail when asked, with the drawing\'s labels', async () => {
    const doc = await newDrawing('Answer')
    expect(await narrationAnswer(doc.path)).toEqual({ path: doc.path, takes: 0, overview: '' })
    expect((await refusal(narrationAnswer(doc.path, { part: '1' }))).status).toBe(404)
    await saveNarrationTake(doc.path, take('t1'))
    const overview = await narrationAnswer(doc.path)
    expect(overview.takes).toBe(1)
    expect(overview.overview).toContain('part 1  0:01-0:03  orders (box): "the orders table is the core table"')
    const detail = await narrationAnswer(doc.path, { take: '1', part: '1' })
    expect(detail.detail).toContain('about: orders (box): pointer on it from 0:00.5')
    expect((await refusal(narrationAnswer(doc.path, { part: '3' }))).status).toBe(404)
    expect((await refusal(narrationAnswer(doc.path, { take: 'x' }))).status).toBe(400)
    expect((await refusal(narrationAnswer('inbox/Missing.excalidraw'))).status).toBe(404)
  })
})
