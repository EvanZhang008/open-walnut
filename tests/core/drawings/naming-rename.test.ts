/**
 * Drawing names (core/drawings/paths.ts, store.ts createDrawing) and renames (renameDrawing):
 * each fallback of the automatic title, path safety, unique numbering, the `walnutTitle` source in
 * the scene, and a rename that moves the scene and its companion note under CAS.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('drawings-naming'))
// The notes index is not under test: keep the reconciler off the real search index.
vi.mock('../../../src/core/search/wiring.js', () => ({
  isSearchV2Enabled: () => true,
  searchV2Lane: vi.fn(async () => []),
  upsertSearchV2File: vi.fn(async () => {}),
  sweepSearchV2Files: vi.fn(async () => ({ changed: 0, removed: 0 })),
  getSearchIndexStatus: vi.fn(() => ({ enabled: true, model: null, docs: 0, byKind: {}, backfillRunning: false, error: null })),
  searchIndexBackfillRunning: vi.fn(() => false),
}))

import { NOTES_DIR } from '../../../src/constants.js'
import { addTask } from '../../../src/core/task-manager.js'
import { closeDb } from '../../../src/core/task-db.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { createDrawing, DrawingConflictError, readDrawing, renameDrawing, writeDrawing, type DrawingDoc } from '../../../src/core/drawings/store.js'
import { autoDrawingTitle, datedDrawingTitle, firstLineName } from '../../../src/core/drawings/paths.js'
import { companionPathFor } from '../../../src/core/drawings/companion.js'
import { DrawingInputError } from '../../../src/core/drawings/scene.js'
import { settleIndexBootstrap } from '../../../src/web/routes/notes-v2.js'

const vault = (rel: string) => path.join(NOTES_DIR, ...rel.split('/'))
const exists = (rel: string) => fs.access(vault(rel)).then(() => true, () => false)
const NOW = new Date(2026, 10, 16, 14, 7)

async function refusal(p: Promise<unknown>, status: number): Promise<Error> {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err, 'expected a refusal').toBeInstanceOf(DrawingInputError)
  expect((err as DrawingInputError).status).toBe(status)
  return err as Error
}

function asDoc(v: unknown): DrawingDoc {
  if (!v || typeof v !== 'object' || 'notModified' in v) throw new Error('expected a full document')
  return v as DrawingDoc
}

let taskId = ''

beforeAll(async () => {
  await fs.mkdir(NOTES_DIR, { recursive: true })
  taskId = (await addTask({ title: 'Interview prep: system design', project: 'Personal' })).task.id
})

afterAll(async () => {
  await settleIndexBootstrap()
  closeDb()
})

describe('automatic titles', () => {
  it('takes the first non-empty line, trimmed, path-safe and at most 60 characters', () => {
    expect(firstLineName('\n   \n  Login flow / v2  \nsecond line')).toBe('Login flow - v2')
    expect(firstLineName('a:b*c?"d"<e>|f\\g')).toBe('a-b-c--d--e--f-g')
    expect(firstLineName('...\n../..')).toBe('-')
    expect(firstLineName('x'.repeat(100))).toBe('x'.repeat(60))
    // Cut by code point: a 61st emoji is dropped whole, never split.
    expect(Array.from(firstLineName('\u{1F680}'.repeat(61))!)).toHaveLength(60)
    expect(firstLineName('   \n\t\n')).toBeNull()
  })

  it('falls back from the first text to the task title to the local date and time', () => {
    expect(autoDrawingTitle({ firstText: 'Cache layer', taskTitle: 'Task', now: NOW })).toBe('Cache layer')
    expect(autoDrawingTitle({ firstText: '  \n ', taskTitle: 'Task: one', now: NOW })).toBe('Task- one')
    expect(autoDrawingTitle({ firstText: '...', taskTitle: '...', now: NOW })).toBe('Drawing 2026-11-16 14.07')
    expect(autoDrawingTitle({ now: NOW })).toBe(datedDrawingTitle(NOW))
    expect(datedDrawingTitle(new Date(2026, 0, 2, 3, 4))).toBe('Drawing 2026-01-02 03.04')
  })
})

describe('createDrawing naming', () => {
  it('names a drawing by its first text, marks it auto, and numbers a taken name', async () => {
    const a = await createDrawing({ firstText: '\nOrder service\nstep two' })
    const b = await createDrawing({ firstText: 'Order service' })
    expect(a.path).toBe('inbox/Order service.excalidraw')
    expect(b.path).toBe('inbox/Order service 2.excalidraw')
    expect(a.scene.appState.walnutTitle).toBe('auto')
    expect(JSON.parse(await fs.readFile(vault(a.path), 'utf-8')).appState.walnutTitle).toBe('auto')
  })

  it('falls back to the task title in the task folder, then to the date', async () => {
    const fromTask = await createDrawing({ taskId, firstText: '   ' }, { now: NOW })
    expect(fromTask.path).toMatch(new RegExp(`^Projects/Personal/Interview prep- system design \\(${taskId}\\)/Interview prep- system design\\.excalidraw$`))
    expect(fromTask.scene.appState.walnutTitle).toBe('auto')
    const dated = await createDrawing({}, { now: NOW })
    expect(dated.path).toBe('inbox/Drawing 2026-11-16 14.07.excalidraw')
    expect((await createDrawing({ title: '  ' }, { now: NOW })).path).toBe('inbox/Drawing 2026-11-16 14.07 2.excalidraw')
  })

  it('keeps a given title as set, and refuses a title or first text that cannot be used', async () => {
    const set = await createDrawing({ title: 'Chosen', firstText: 'Ignored' })
    expect(set.path).toBe('inbox/Chosen.excalidraw')
    expect(set.scene.appState.walnutTitle).toBe('set')
    await refusal(createDrawing({ title: '...' }), 400)
    await refusal(createDrawing({ title: 7 }), 400)
    await refusal(createDrawing({ firstText: 7 }), 400)
    await refusal(createDrawing({ firstText: 'x'.repeat(100_001) }), 413)
  })
})

describe('createDrawing with a create id', () => {
  it('answers a repeat (even one racing the first) with the same file, and a gone file with a new one', async () => {
    const [a, b] = await Promise.all([
      createDrawing({ clientId: 'create-id-0001', firstText: 'Only once' }),
      createDrawing({ clientId: 'create-id-0001', firstText: 'Only once' }),
    ])
    expect(b.path).toBe(a.path)
    const later = await createDrawing({ clientId: 'create-id-0001', firstText: 'Only once' })
    expect(later.path).toBe(a.path)
    expect((await fs.readdir(vault('inbox'))).filter((n) => n.startsWith('Only once') && n.endsWith('.excalidraw'))).toEqual(['Only once.excalidraw'])
    // Without an id every create is a new drawing.
    expect((await createDrawing({ firstText: 'Only once' })).path).toBe('inbox/Only once 2.excalidraw')
    await fs.unlink(vault(a.path))
    const remade = await createDrawing({ clientId: 'create-id-0001', firstText: 'Only once' })
    expect(remade.path).toBe(a.path)
    expect(await exists(remade.path)).toBe(true)
    for (const bad of [5, 'short', 'has space!', 'x'.repeat(101)]) await refusal(createDrawing({ clientId: bad }), 400)
  })

  it('forgets a create id after ten minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const first = await createDrawing({ clientId: 'create-id-0002', title: 'Expiring' })
      vi.setSystemTime(Date.now() + 10 * 60_000 + 1)
      const second = await createDrawing({ clientId: 'create-id-0002', title: 'Expiring' })
      expect(second.path).not.toBe(first.path)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('core/drawings stays below the web layer', () => {
  it('imports no web route (the Notes follow-up of a move is core/note-moves.ts)', async () => {
    const dir = path.join(__dirname, '../../../src/core/drawings')
    const offenders: string[] = []
    for (const name of await fs.readdir(dir)) {
      if (!name.endsWith('.ts')) continue
      const src = await fs.readFile(path.join(dir, name), 'utf-8')
      if (/from ['"][./]*\/web\/|import\(['"][./]*\/web\//.test(src)) offenders.push(name)
    }
    expect(offenders).toEqual([])
  })
})

describe('renameDrawing', () => {
  it('moves the scene and its companion, marks the title set, and announces the move', async () => {
    const doc = await createDrawing({ taskId, title: 'Draft' })
    await writeDrawing(doc.path, doc.revision, { ...doc.scene, elements: [{ id: 't', type: 'text', x: 0, y: 0, text: 'Queue', width: 10, height: 10 }] })
    const before = asDoc(await readDrawing(doc.path))
    const events: unknown[] = []
    const tree: unknown[] = []
    bus.subscribe('test-rename', (event) => {
      if (event.name === EventNames.DRAWING_UPDATED) events.push(event.data)
      if (event.name === EventNames.NOTES_TREE_CHANGED) tree.push(event.data)
    }, { global: true, interest: [EventNames.DRAWING_UPDATED, EventNames.NOTES_TREE_CHANGED] })
    try {
      const renamed = await renameDrawing(doc.path, before.revision, 'Queue design')
      const folder = doc.path.split('/').slice(0, -1).join('/')
      expect(renamed.path).toBe(`${folder}/Queue design.excalidraw`)
      expect(renamed.title).toBe('Queue design')
      expect(renamed.taskId).toBe(taskId)
      expect(renamed.scene.appState.walnutTitle).toBe('set')
      expect(renamed.scene.elements.map((e) => e.id)).toEqual(['t'])
      expect(await exists(doc.path)).toBe(false)
      expect(await exists(companionPathFor(doc.path))).toBe(false)
      const md = await fs.readFile(vault(companionPathFor(renamed.path)), 'utf-8')
      expect(md).toContain(renamed.path.split('/').pop())
      expect(md).toContain('Queue')
      expect(renamed.indexWarning).toBeUndefined()
      await vi.waitFor(() => expect(events).toContainEqual({ path: renamed.path, revision: renamed.revision, from: doc.path }))
      await vi.waitFor(() => expect(tree).toContainEqual({ path: renamed.path }))
    } finally {
      bus.unsubscribe('test-rename')
    }
  })

  it('numbers a taken name, keeps an own name in place, and changes only the letter case', async () => {
    await createDrawing({ title: 'Taken' })
    const doc = await createDrawing({ title: 'Mine' })
    const numbered = await renameDrawing(doc.path, doc.revision, 'Taken')
    expect(numbered.path).toBe('inbox/Taken 2.excalidraw')
    const same = await renameDrawing(numbered.path, numbered.revision, 'Taken 2')
    expect(same.path).toBe(numbered.path)
    const cased = await renameDrawing(same.path, same.revision, 'TAKEN 2')
    expect(cased.path).toBe('inbox/TAKEN 2.excalidraw')
    expect((await fs.readdir(vault('inbox'))).filter((n) => n.toLowerCase().startsWith('taken 2'))).toEqual(
      expect.arrayContaining(['TAKEN 2.excalidraw', 'TAKEN 2.drawing.md']),
    )
    expect(asDoc(await readDrawing(cased.path)).indexWarning).toBeUndefined()
  })

  it('turns an auto title into a set one', async () => {
    const auto = await createDrawing({ firstText: 'Scratch' })
    expect(auto.scene.appState.walnutTitle).toBe('auto')
    const renamed = await renameDrawing(auto.path, auto.revision, 'Payments')
    expect(renamed.scene.appState.walnutTitle).toBe('set')
    expect(renamed.revision).not.toBe(auto.revision)
  })

  it('refuses a stale revision with the current drawing, a bad title and a missing drawing', async () => {
    const doc = await createDrawing({ title: 'Guarded' })
    const saved = await writeDrawing(doc.path, doc.revision, { ...doc.scene, elements: [{ id: 'r', type: 'rectangle', x: 0, y: 0, width: 5, height: 5 }] })
    const err = await refusal(renameDrawing(doc.path, doc.revision, 'Other'), 409)
    expect(err).toBeInstanceOf(DrawingConflictError)
    expect((err as DrawingConflictError).current.revision).toBe(saved.revision)
    expect(await exists(doc.path)).toBe(true)
    expect(await exists('inbox/Other.excalidraw')).toBe(false)
    for (const bad of ['', '   ', '...', 5, 'x'.repeat(201)]) await refusal(renameDrawing(doc.path, saved.revision, bad), 400)
    await refusal(renameDrawing(doc.path, undefined, 'Other'), 400)
    await refusal(renameDrawing('inbox/missing.excalidraw', 'r', 'Other'), 404)
    await refusal(renameDrawing('../escape.excalidraw', 'r', 'Other'), 400)
  })

  it('never renames onto a leftover companion: the name counts as taken, so the companion always follows', async () => {
    // A companion whose scene was deleted outside Walnut stays behind at its name.
    const gone = await createDrawing({ title: 'Leftover' })
    await fs.unlink(vault(gone.path))
    expect(await exists('inbox/Leftover.drawing.md')).toBe(true)
    const doc = await createDrawing({ title: 'Moving' })
    const renamed = await renameDrawing(doc.path, doc.revision, 'Leftover')
    expect(renamed.path).toBe('inbox/Leftover 2.excalidraw')
    expect(await exists('inbox/Leftover 2.drawing.md')).toBe(true)
    // No orphan: the companion moved with its scene.
    expect(await exists('inbox/Moving.drawing.md')).toBe(false)
    expect(asDoc(await readDrawing(renamed.path)).indexWarning).toBeUndefined()
  })

  it('a change of letter case only moves on when a different companion holds the new name', async () => {
    const probe = await createDrawing({ title: 'Probe case' })
    const caseSensitive = !(await exists('inbox/PROBE CASE.excalidraw'))
    if (!caseSensitive) return // on a case-insensitive disk the two names are one file
    const gone = await createDrawing({ title: 'MIXED' })
    await fs.unlink(vault(gone.path))
    const doc = await createDrawing({ title: 'Mixed' })
    const renamed = await renameDrawing(doc.path, doc.revision, 'MIXED')
    expect(renamed.path).toBe('inbox/MIXED 2.excalidraw')
    expect(await exists('inbox/Mixed.drawing.md')).toBe(false)
    expect(probe.path).toBe('inbox/Probe case.excalidraw')
  })

  it('lets one of two racing renames win and refuses the other as stale', async () => {
    const doc = await createDrawing({ title: 'Race' })
    const results = await Promise.allSettled([renameDrawing(doc.path, doc.revision, 'Left'), renameDrawing(doc.path, doc.revision, 'Right')])
    const won = results.filter((r) => r.status === 'fulfilled')
    expect(won).toHaveLength(1)
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect([404, 409]).toContain((lost.reason as DrawingInputError).status)
    expect((await exists('inbox/Left.excalidraw')) !== (await exists('inbox/Right.excalidraw'))).toBe(true)
  })
})
