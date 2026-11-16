/**
 * Drawing storage (src/core/drawings/store.ts) against a real vault in a temp home:
 * placement by the real task, path safety, CAS under the note lock, atomic saves that never
 * lose the old scene, appends, and the companion note's partial-failure and repair path.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('drawings-store'))

import { NOTES_DIR } from '../../../src/constants.js'
import { addTask, updateTask } from '../../../src/core/task-manager.js'
import { closeDb } from '../../../src/core/task-db.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import {
  appendToDrawing, createDrawing, DrawingConflictError, editDrawing, listDrawings, readDrawing, renderDrawing, resetDrawingCaches,
  sceneBytesOf, writeDrawing, writeDrawingBody, type DrawingDoc,
} from '../../../src/core/drawings/store.js'
import { DrawingInputError, emptyScene, MAX_SCENE_BYTES, sceneRevision } from '../../../src/core/drawings/scene.js'
import { companionPathFor } from '../../../src/core/drawings/companion.js'
import { _sceneWorkerRunning, LARGE_SCENE_BYTES } from '../../../src/core/drawings/scene-codec.js'
import { _resetRenderSweep, drawingRenderDir, KEEP_REVISIONS, MAX_IDLE_MS } from '../../../src/core/drawings/render-file.js'

const vault = (rel: string) => path.join(NOTES_DIR, ...rel.split('/'))
const read = (rel: string) => fs.readFile(vault(rel), 'utf-8')

async function expectStatus(p: Promise<unknown>, status: number, match?: RegExp): Promise<DrawingInputError> {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err, 'expected a refusal').toBeInstanceOf(DrawingInputError)
  expect((err as DrawingInputError).status).toBe(status)
  if (match) expect((err as Error).message).toMatch(match)
  return err as DrawingInputError
}

function asDoc(v: unknown): DrawingDoc {
  if (!v || typeof v !== 'object' || 'notModified' in v) throw new Error('expected a full document')
  return v as DrawingDoc
}

let taskId = ''
const PROJECT = 'Caf\u00e9 \u8bbe\u8ba1' // "Cafe" with an accent, then two CJK characters

beforeAll(async () => {
  await fs.mkdir(NOTES_DIR, { recursive: true })
  const { task } = await addTask({ title: 'Plan the \u{1F680} launch: v2/v3', project: PROJECT })
  taskId = task.id
  await createSessionRecord('sess-drawing-1', taskId, PROJECT)
})

afterAll(() => {
  closeDb()
})

describe('placement', () => {
  it('puts a drawing with no task in inbox and numbers a repeated title', async () => {
    const a = await createDrawing({ title: 'Sketch' })
    const b = await createDrawing({ title: 'Sketch' })
    expect(a.path).toBe('inbox/Sketch.excalidraw')
    expect(b.path).toBe('inbox/Sketch 2.excalidraw')
    expect(a).toMatchObject({ title: 'Sketch', scene: emptyScene() })
    expect(a.revision).toBe(sceneRevision(await read(a.path)))
    expect(a.indexWarning).toBeUndefined()
    const untitled = await createDrawing({})
    expect(untitled.path).toBe('inbox/Untitled drawing.excalidraw')
  })

  it('puts a task drawing in the task\'s real project and a folder named for its title and id', async () => {
    const doc = await createDrawing({ taskId, title: 'Flow / chart' })
    expect(doc.path).toBe(`Projects/${PROJECT}/Plan the \u{1F680} launch- v2-v3 (${taskId})/Flow - chart.excalidraw`)
    expect(doc.taskId).toBe(taskId)
    const viaSession = await createDrawing({ sessionId: 'sess-drawing-1', title: 'Second' })
    expect(path.posix.dirname(viaSession.path)).toBe(path.posix.dirname(doc.path))
  })

  it('keeps the task folder when the task is renamed, and lists by the id', async () => {
    await updateTask(taskId, { title: 'Renamed task' })
    const doc = await createDrawing({ taskId, title: 'After rename' })
    expect(doc.path).toContain(`(${taskId})/After rename.excalidraw`)
    expect(doc.path).toContain('launch')
    const listed = await listDrawings({ taskId })
    expect(listed.map((d) => d.title).sort()).toEqual(['After rename', 'Flow - chart', 'Second'])
    for (const d of listed) expect(d).toMatchObject({ taskId, revision: expect.any(String), updatedAt: expect.any(String) })
    const all = await listDrawings({})
    expect(all.length).toBeGreaterThanOrEqual(listed.length + 3)
  })

  it('answers 404 for a task or session that does not exist, never Inbox', async () => {
    await expectStatus(createDrawing({ taskId: 'no-such-task-id' }), 404, /Task not found/)
    await expectStatus(createDrawing({ sessionId: 'no-such-session' }), 404, /Session not found/)
    await expectStatus(listDrawings({ taskId: 'no-such-task-id' }), 404)
    await expectStatus(createDrawing({ taskId: 42 as unknown as string }), 400)
  })
})

describe('path safety', () => {
  it('refuses traversal, absolute, hidden and non-drawing paths', async () => {
    for (const bad of ['../x.excalidraw', 'a/../../x.excalidraw', '/etc/x.excalidraw', 'C:/x.excalidraw', '.git/x.excalidraw', 'inbox/x.md', 'inbox\0/x.excalidraw', '', 'inbox//x.excalidraw']) {
      await expectStatus(readDrawing(bad), 400)
    }
    await expectStatus(readDrawing('inbox/missing.excalidraw'), 404)
  })

  it('refuses a linked file and a folder that leads out of the vault', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'drawing-outside-'))
    try {
      const scene = JSON.stringify(emptyScene())
      await fs.writeFile(path.join(outside, 'secret.excalidraw'), scene)
      await fs.symlink(outside, vault('escape'))
      await fs.symlink(path.join(outside, 'secret.excalidraw'), vault('inbox/linked.excalidraw'))
      await expectStatus(readDrawing('escape/secret.excalidraw'), 400, /outside/)
      await expectStatus(readDrawing('inbox/linked.excalidraw'), 400, /linked/)
      await expectStatus(writeDrawing('escape/secret.excalidraw', sceneRevision(scene), emptyScene()), 400)
      const listed = (await listDrawings({})).map((d) => d.path)
      expect(listed).not.toContain('inbox/linked.excalidraw')
      expect(listed.some((p) => p.startsWith('escape/'))).toBe(false)
      expect(await fs.readFile(path.join(outside, 'secret.excalidraw'), 'utf-8')).toBe(scene)
    } finally {
      await fs.rm(vault('escape'), { force: true })
      await fs.rm(vault('inbox/linked.excalidraw'), { force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})

describe('saving', () => {
  it('refuses a stale revision with the current document, and keeps the bytes', async () => {
    const doc = await createDrawing({ title: 'Cas' })
    const saved = await writeDrawing(doc.path, doc.revision, { ...doc.scene, elements: [{ id: 'r1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }] })
    expect(saved.revision).not.toBe(doc.revision)
    const before = await read(doc.path)
    const err = await expectStatus(writeDrawing(doc.path, doc.revision, emptyScene()), 409)
    expect(err).toBeInstanceOf(DrawingConflictError)
    expect((err as DrawingConflictError).current).toMatchObject({ path: doc.path, revision: saved.revision })
    expect((err as DrawingConflictError).current.scene.elements.map((e) => e.id)).toEqual(['r1'])
    expect(await read(doc.path)).toBe(before)
    await expectStatus(writeDrawing(doc.path, undefined, emptyScene()), 400, /revision/)
  })

  it('lets exactly one of two concurrent saves of one revision win', async () => {
    const doc = await createDrawing({ title: 'Race' })
    const scene = (id: string) => ({ ...doc.scene, elements: [{ id, type: 'ellipse', x: 0, y: 0, width: 5, height: 5 }] })
    const results = await Promise.allSettled([
      writeDrawing(doc.path, doc.revision, scene('left')),
      writeDrawing(doc.path, doc.revision, scene('right')),
      appendToDrawing(doc.path, doc.revision, [{ type: 'text', x: 0, y: 0, text: 'third' }]),
    ])
    const won = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<DrawingDoc>[]
    const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(2)
    for (const l of lost) expect(l.reason).toBeInstanceOf(DrawingConflictError)
    const onDisk = JSON.parse(await read(doc.path))
    expect(onDisk.elements).toEqual(won[0]!.value.scene.elements)
    // No temp file is left behind beside the scene.
    expect((await fs.readdir(vault('inbox'))).filter((n) => n.includes('.tmp-'))).toEqual([])
  })

  it('tells open editors each time the scene bytes change, and only then', async () => {
    const seen: Array<{ path: string; revision: string }> = []
    bus.subscribe('drawing-updated-test', (e) => { seen.push(e.data as { path: string; revision: string }) }, { global: true, interest: [EventNames.DRAWING_UPDATED] })
    try {
      const doc = await createDrawing({ title: 'Pushed' })
      const edited = await editDrawing(doc.path, doc.revision, { add: [{ type: 'rectangle', x: 0, y: 0, width: 20, height: 20, text: 'A' }] })
      await vi.waitFor(() => expect(seen).toContainEqual({ path: doc.path, revision: edited.revision }))
      const count = seen.length
      // The same bytes again (an editor re-saving what is on disk) write nothing and announce nothing.
      await writeDrawing(doc.path, edited.revision, edited.scene)
      // A real change after it: once its event is in, the same-bytes save before it was judged, and
      // the only new event is the change's (the bus delivers in order).
      const next = await editDrawing(doc.path, edited.revision, { add: [{ type: 'rectangle', x: 40, y: 0, width: 20, height: 20, text: 'B' }] })
      await vi.waitFor(() => expect(seen).toContainEqual({ path: doc.path, revision: next.revision }))
      expect(seen.slice(count)).toEqual([{ path: doc.path, revision: next.revision }])
    } finally {
      bus.unsubscribe('drawing-updated-test')
    }
  })

  it('refuses an oversize scene and keeps the old one', async () => {
    const doc = await createDrawing({ title: 'Big' })
    const before = await read(doc.path)
    const huge = { ...doc.scene, files: { f: { dataURL: 'x'.repeat(MAX_SCENE_BYTES) } } }
    await expectStatus(writeDrawing(doc.path, doc.revision, huge), 413)
    expect(await read(doc.path)).toBe(before)
  })

  it('reads a file that is not a scene as 422 and never rewrites it', async () => {
    await fs.writeFile(vault('inbox/broken.excalidraw'), '{ not json')
    await expectStatus(readDrawing('inbox/broken.excalidraw'), 422)
    await expectStatus(writeDrawing('inbox/broken.excalidraw', sceneRevision('{ not json'), emptyScene()), 422)
    expect(await read('inbox/broken.excalidraw')).toBe('{ not json')
  })

  it('appends without removing anything and refuses an existing id', async () => {
    const doc = await createDrawing({ title: 'Append' })
    const first = await appendToDrawing(doc.path, doc.revision, [{ id: 'box', type: 'rectangle', x: 0, y: 0, width: 100, height: 40, text: 'Box' }])
    expect(first.scene.elements.map((e) => e.type)).toEqual(['rectangle', 'text'])
    const box = first.idMap!.box!
    expect(first.scene.elements[0]!.id).toBe(box)
    const second = await appendToDrawing(doc.path, first.revision, [{ type: 'arrow', start: { id: box }, end: { id: 'box2' } }, { id: 'box2', type: 'ellipse', x: 300, y: 0 }])
    expect(second.scene.elements.slice(0, 2).map((e) => e.id)).toEqual(first.scene.elements.map((e) => e.id))
    expect(second.scene.elements).toHaveLength(4)
    expect(Object.keys(second.idMap!)).toEqual(['box2'])
    const before = await read(doc.path)
    await expectStatus(appendToDrawing(doc.path, second.revision, [{ id: box, type: 'rectangle', x: 0, y: 0 }]), 400, /already an element/)
    await expectStatus(appendToDrawing(doc.path, first.revision, [{ type: 'rectangle', x: 0, y: 0 }]), 409)
    expect(await read(doc.path)).toBe(before)
  })

  it('answers a revision the caller holds without the scene', async () => {
    const doc = await createDrawing({ title: 'Poll' })
    const same = await readDrawing(doc.path, { notModified: (r) => r === doc.revision })
    expect(same).toEqual({ notModified: true, revision: doc.revision })
    expect(asDoc(await readDrawing(doc.path, { notModified: () => false })).scene).toEqual(doc.scene)
  })
})

describe('the companion note', () => {
  it('carries the title, the drawing text and a link, and announces itself to Notes', async () => {
    const events: Array<{ source?: string }> = []
    bus.subscribe('drawing-test', (e) => { events.push(e.data as { source?: string }) }, { global: true, interest: [EventNames.NOTES_UPDATED] })
    try {
      const doc = await createDrawing({ title: 'Architecture' })
      const saved = await appendToDrawing(doc.path, doc.revision, [{ type: 'rectangle', x: 0, y: 0, text: 'Gateway' }, { type: 'text', x: 0, y: 200, text: 'Queue <!-- end -->' }])
      const md = await read(companionPathFor(doc.path))
      expect(md).toMatch(/^---\nid: n_/)
      expect(md).toContain('kind: walnut-drawing')
      expect(md).toContain('# Architecture')
      expect(md).toContain('- Gateway')
      expect(md).toContain('- Queue < !-- end -- >')
      expect(md).toContain(`/apps/walnut-drawing~main?path=${encodeURIComponent(doc.path)}`)
      expect(md).toContain(`revision=${saved.revision}`)
      await vi.waitFor(() => expect(events.some((e) => e.source === `notes/${companionPathFor(doc.path).replace(/\.md$/, '')}`)).toBe(true))
    } finally {
      bus.unsubscribe('drawing-test')
    }
  })

  it('keeps what a person wrote outside the generated block', async () => {
    const doc = await createDrawing({ title: 'Edited' })
    const mdRel = companionPathFor(doc.path)
    const md = await read(mdRel)
    await fs.writeFile(vault(mdRel), md.replace('---\n<!--', '---\nMy own intro.\n\n<!--') + '\nMy own outro.\n')
    await appendToDrawing(doc.path, doc.revision, [{ type: 'text', x: 0, y: 0, text: 'Fresh' }])
    const after = await read(mdRel)
    expect(after).toContain('My own intro.')
    expect(after).toContain('My own outro.')
    expect(after).toContain('- Fresh')
    expect(after.match(/walnut-drawing:begin/g)).toHaveLength(1)
  })

  it('never writes over a note that is not one of ours', async () => {
    await fs.mkdir(vault('inbox'), { recursive: true })
    await fs.writeFile(vault('inbox/Taken.drawing.md'), '# A person\'s own note\n')
    const doc = await createDrawing({ title: 'Taken' })
    // The name moved on rather than share a companion path with someone's note.
    expect(doc.path).toBe('inbox/Taken 2.excalidraw')
    expect(await read('inbox/Taken.drawing.md')).toBe('# A person\'s own note\n')
    // A scene placed by hand beside it: the save works and says what it left alone.
    await fs.writeFile(vault('inbox/Taken.excalidraw'), JSON.stringify(emptyScene()))
    const saved = await writeDrawing('inbox/Taken.excalidraw', sceneRevision(JSON.stringify(emptyScene())), emptyScene())
    expect(saved.indexWarning).toMatch(/did not make/)
    expect(await read('inbox/Taken.drawing.md')).toBe('# A person\'s own note\n')
  })

  it('saves the scene when the companion cannot be written, says so, and repairs it on the next read', async () => {
    const doc = await createDrawing({ title: 'Partial' })
    const mdAbs = vault(companionPathFor(doc.path))
    const before = await fs.readFile(mdAbs, 'utf-8')
    await fs.rm(mdAbs)
    await fs.mkdir(mdAbs) // the companion path is a folder: every write of it fails
    const saved = await appendToDrawing(doc.path, doc.revision, [{ type: 'text', x: 0, y: 0, text: 'Survives' }])
    expect(saved.indexWarning).toMatch(/saved, but its Notes entry/)
    expect(JSON.parse(await read(doc.path)).elements).toHaveLength(1)
    // The same read again still reports it while it cannot be fixed.
    expect(asDoc(await readDrawing(doc.path)).indexWarning).toBeDefined()
    await fs.rmdir(mdAbs)
    await fs.writeFile(mdAbs, before) // the companion is back, but from an older revision
    const reread = asDoc(await readDrawing(doc.path))
    expect(reread.indexWarning).toBeUndefined()
    expect(reread.revision).toBe(saved.revision)
    const md = await fs.readFile(mdAbs, 'utf-8')
    expect(md).toContain('- Survives')
    expect(md).toContain(`revision=${saved.revision}`)
  })
})

describe('reads never create', () => {
  it('leaves a missing companion missing on read, and the next save creates it', async () => {
    const doc = await createDrawing({ title: 'Lazy' })
    const mdAbs = vault(companionPathFor(doc.path))
    await fs.rm(mdAbs)
    resetDrawingCaches()
    expect(asDoc(await readDrawing(doc.path)).indexWarning).toBeUndefined()
    expect(await readDrawing(doc.path, { notModified: () => true })).toMatchObject({ notModified: true })
    await expect(fs.access(mdAbs)).rejects.toThrow()
    const saved = await appendToDrawing(doc.path, doc.revision, [{ type: 'text', x: 0, y: 0, text: 'Now' }])
    expect(await fs.readFile(mdAbs, 'utf-8')).toContain(`revision=${saved.revision}`)
  })
})

describe('large scenes', () => {
  it('parses, encodes and hashes a scene over 1 MB in the worker, once, with the same answer', async () => {
    const doc = await createDrawing({ title: 'Large' })
    const picture = `data:image/png;base64,${'A'.repeat(1_500_000)}`
    const scene = { ...emptyScene(), elements: [{ id: 'img', type: 'image', x: 0, y: 0, width: 10, height: 10, fileId: 'f1' }], files: { f1: { id: 'f1', mimeType: 'image/png', dataURL: picture } } }
    const body = JSON.stringify({ path: doc.path, revision: doc.revision, scene })
    const saved = await writeDrawingBody(body)
    expect(_sceneWorkerRunning()).toBe(true)
    const onDisk = await read(doc.path)
    expect(saved.revision).toBe(sceneRevision(onDisk))
    expect(sceneBytesOf(saved)).toBe(onDisk)
    const appended = await appendToDrawing(doc.path, saved.revision, [{ type: 'text', x: 0, y: 40, text: 'caption' }])
    expect(appended.scene.files).toEqual(scene.files)
    expect(appended.scene.elements.map((e) => e.type)).toEqual(['image', 'text'])
    const reread = asDoc(await readDrawing(doc.path))
    expect(reread.revision).toBe(appended.revision)
    expect(await read(companionPathFor(doc.path))).toContain('- caption')
    // A stale large save is a 409 with the current document, without its scene being parsed here.
    const stale = await writeDrawingBody(body).then(() => null, (e: unknown) => e)
    expect(stale).toBeInstanceOf(DrawingConflictError)
    expect((stale as DrawingConflictError).current.revision).toBe(appended.revision)
    await expectStatus(writeDrawingBody(JSON.stringify({ path: doc.path, revision: appended.revision, scene: { ...scene, type: 'other' } }) + ' '.repeat(LARGE_SCENE_BYTES)), 400, /scene.type/)
  })
})

describe('edit and render', () => {
  it('tidies strokes into boxes and an arrow in one checked step, and refuses a stale one', async () => {
    const doc = await createDrawing({ title: 'Tidy' })
    const drawn = await appendToDrawing(doc.path, doc.revision, [0, 1, 2].map((k) => ({ type: 'freedraw', x: k * 50, y: 0, points: [[0, 0], [20, 10]] })))
    const strokes = drawn.scene.elements.map((e) => e.id)
    const tidy = await editDrawing(doc.path, drawn.revision, {
      remove: strokes,
      add: [
        { id: 'in', type: 'rectangle', x: 0, y: 0, width: 120, height: 60, text: 'In' },
        { id: 'out', type: 'rectangle', x: 300, y: 0, width: 120, height: 60, text: 'Out' },
        { type: 'arrow', start: { id: 'in' }, end: { id: 'out' } },
      ],
    })
    expect(Object.keys(tidy.idMap!).sort()).toEqual(['in', 'out'])
    const reread = asDoc(await readDrawing(doc.path))
    expect(reread.revision).toBe(tidy.revision)
    const live = reread.scene.elements.filter((e) => !e.isDeleted)
    expect(live.map((e) => e.type)).toEqual(['rectangle', 'text', 'rectangle', 'text', 'arrow'])
    const arrow = live.find((e) => e.type === 'arrow')!
    for (const [side, id] of [['startBinding', tidy.idMap!.in], ['endBinding', tidy.idMap!.out]] as const) {
      expect((arrow[side] as { elementId: string }).elementId).toBe(id)
      expect((live.find((e) => e.id === id)!.boundElements as Array<{ id: string }>).map((b) => b.id)).toContain(arrow.id)
    }
    expect(await read(companionPathFor(doc.path))).toContain('- In')
    await expectStatus(editDrawing(doc.path, drawn.revision, { remove: [tidy.idMap!.in!] }), 409)
    await expectStatus(editDrawing(doc.path, 'stale', { update: [{ id: tidy.idMap!.in!, type: 'text' }] }), 409)
    await expectStatus(editDrawing(doc.path, 'stale', { update: 'nope' }), 400)
  })

  it('renders a drawing to an SVG and a PNG named by its revision', async () => {
    const doc = await createDrawing({ title: 'Picture' })
    const saved = await appendToDrawing(doc.path, doc.revision, [
      { id: 'a', type: 'rectangle', x: 0, y: 0, width: 200, height: 80, text: '\u767b\u5f55\nsecond line' },
      { id: 'b', type: 'ellipse', x: 320, y: 0, width: 100, height: 80 },
      { type: 'arrow', start: { id: 'a' }, end: { id: 'b' } },
    ])
    const svg = await renderDrawing(doc.path, 'svg')
    expect(svg).toMatchObject({ path: doc.path, revision: saved.revision, format: 'svg' })
    expect(path.isAbsolute(svg.svgPath!)).toBe(true)
    expect(path.basename(svg.svgPath!)).toMatch(new RegExp(`^[0-9a-f]{16}-${saved.revision}\\.svg$`))
    expect(svg.note).toMatch(/host_copy/)
    const text = await fs.readFile(svg.svgPath!, 'utf-8')
    expect(text).toContain('\u767b\u5f55')
    expect(text).toContain('second line')
    const png = await renderDrawing(doc.path, 'png')
    if (png.format === 'png') {
      const bytes = await fs.readFile(png.pngPath!)
      expect(bytes.subarray(1, 4).toString()).toBe('PNG')
      // IHDR width and height, big-endian at bytes 16 and 20.
      expect(bytes.readUInt32BE(16)).toBe(png.width)
      expect(bytes.readUInt32BE(20)).toBe(png.height)
    } else {
      expect(png.note).toMatch(/PNG/)
      expect(png.svgPath).toBe(svg.svgPath)
    }
    expect(png.width).toBe(svg.width)
    await expectStatus(renderDrawing(doc.path, 'gif'), 400)
  })

  it('keeps the newest two revisions of a drawing and sweeps pictures idle for a week', async () => {
    const doc = await createDrawing({ title: 'Versions' })
    const dir = drawingRenderDir()
    await fs.mkdir(dir, { recursive: true })
    const idle = path.join(dir, `${'0'.repeat(16)}-${'1'.repeat(64)}.svg`)
    await fs.writeFile(idle, '<svg/>')
    const longAgo = new Date(Date.now() - MAX_IDLE_MS - 60_000)
    await fs.utimes(idle, longAgo, longAgo)
    _resetRenderSweep()
    let revision = doc.revision
    const rendered: string[] = []
    for (let k = 0; k < 4; k++) {
      const next = await appendToDrawing(doc.path, revision, [{ type: 'text', x: 0, y: k * 30, text: `v${k}` }])
      revision = next.revision
      rendered.push((await renderDrawing(doc.path, 'svg')).svgPath!)
      await new Promise((r) => setTimeout(r, 15))
    }
    const key = path.basename(rendered[0]!).slice(0, 16)
    const left = (await fs.readdir(dir)).filter((n) => n.startsWith(`${key}-`) && n.endsWith('.svg'))
    expect(left.sort()).toEqual(rendered.slice(-KEEP_REVISIONS).map((p) => path.basename(p)).sort())
    await expect(fs.access(idle)).rejects.toThrow()
    // The same revision again reuses its file.
    expect((await renderDrawing(doc.path, 'svg')).svgPath).toBe(rendered[3])
  })
})
