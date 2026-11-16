/**
 * The pure rules of drawings: name folding and path checks (paths.ts), the companion note's
 * merge that touches only its own block (companion.ts), and the scene file shape (scene.ts).
 */
import { describe, expect, it } from 'vitest'
import { cleanScenePath, foldName, isTaskFolder, taskFolderFor, taskIdOfFolder } from '../../../src/core/drawings/paths.js'
import { companionBlock, companionPathFor, companionRevision, isOwnCompanion, mergeCompanion, retargetCompanion } from '../../../src/core/drawings/companion.js'
import { DrawingInputError, parseSceneBytes, sceneText, validateSceneInput } from '../../../src/core/drawings/scene.js'
import { trackingNotePathFor } from '../../../src/core/tracking-note.js'

describe('paths', () => {
  it('folds a title into one safe name, keeping Unicode and never splitting an emoji', () => {
    expect(foldName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j')
    expect(foldName('  ..hidden  ')).toBe('hidden')
    expect(foldName('trailing...')).toBe('trailing')
    expect(foldName('\u8bbe\u8ba1 caf\u00e9')).toBe('\u8bbe\u8ba1 caf\u00e9')
    expect(foldName('...')).toBeNull()
    const emoji = 'x'.repeat(59) + '\u{1F680}\u{1F680}'
    expect(Array.from(foldName(emoji, 60)!)).toHaveLength(60)
    expect(foldName(emoji, 60)!.endsWith('\u{1F680}')).toBe(true)
  })

  it('places a task under its own project folder, beside the project\'s tracking note', () => {
    const folder = taskFolderFor({ id: 'abc-123', title: 'Ship it', project: 'Platform' })
    expect(folder).toBe('Projects/Platform/Ship it (abc-123)')
    expect(trackingNotePathFor('Platform')).toBe('Projects/Platform/Tracking.md')
    expect(taskFolderFor({ id: 'abc-123', title: 'Ship it', project: '' })).toBe('inbox/Ship it (abc-123)')
    expect(() => taskFolderFor({ id: 'x', title: 't', project: '...' })).toThrow(DrawingInputError)
    expect(taskIdOfFolder('Ship it (abc-123)')).toBe('abc-123')
    expect(isTaskFolder('Renamed (abc-123)', 'abc-123')).toBe(true)
    expect(isTaskFolder('Ship it (abc-1234)', 'abc-123')).toBe(false)
  })

  it('accepts only clean vault-relative .excalidraw paths', () => {
    expect(cleanScenePath('a\\b/c.excalidraw')).toBe('a/b/c.excalidraw')
    for (const bad of [undefined, 5, '', '../a.excalidraw', 'a/./b.excalidraw', '/a.excalidraw', 'C:\\a.excalidraw', '.a/b.excalidraw', 'a.md', '.excalidraw']) {
      expect(() => cleanScenePath(bad), String(bad)).toThrow(DrawingInputError)
    }
  })
})

describe('companion', () => {
  const input = { scenePath: 'inbox/Map.excalidraw', title: 'Map', revision: 'r1', texts: ['North', 'South'] }

  it('creates a note with its kind, its block and the editor link', () => {
    const merge = mergeCompanion(null, input)
    expect(merge.kind).toBe('write')
    const content = (merge as { content: string }).content
    expect(content).toMatch(/^---\nkind: walnut-drawing\ndrawing: Map.excalidraw\n---\n/)
    expect(content).toContain('[Open the editable drawing](/apps/walnut-drawing~main?path=inbox%2FMap.excalidraw)')
    expect(companionRevision(content)).toBe('r1')
    expect(companionPathFor(input.scenePath)).toBe('inbox/Map.drawing.md')
  })

  it('replaces only the block and leaves the rest byte for byte', () => {
    const first = (mergeCompanion(null, input) as { content: string }).content
    const edited = first.replace('drawing: Map.excalidraw\n', 'drawing: Map.excalidraw\ntags: [maps]\n').replace('---\n<!--', '---\nIntro.\n<!--') + 'Outro.\n'
    const next = mergeCompanion(edited, { ...input, revision: 'r2', texts: ['East'] })
    expect(next.kind).toBe('write')
    const out = (next as { content: string }).content
    expect(out.replace(companionBlock({ ...input, revision: 'r2', texts: ['East'] }), '<B>')).toBe(edited.replace(companionBlock(input), '<B>'))
    expect(mergeCompanion(out, { ...input, revision: 'r2', texts: ['East'] })).toEqual({ kind: 'unchanged' })
  })

  it('leaves a note that is not ours alone and restores a removed block of ours', () => {
    expect(mergeCompanion('# Mine\n', input).kind).toBe('foreign')
    const ours = '---\nkind: walnut-drawing\ndrawing: Map.excalidraw\n---\nkept\n'
    const merged = mergeCompanion(ours, input) as { content: string }
    expect(merged.content.startsWith(`${ours}\n<!-- walnut-drawing:begin`)).toBe(true)
    // The kind alone, or our markers in a note for another drawing, are not ours.
    expect(mergeCompanion('---\nkind: walnut-drawing\n---\nkept\n', input).kind).toBe('foreign')
    const other = (mergeCompanion(null, { ...input, scenePath: 'inbox/Other.excalidraw' }) as { content: string }).content
    expect(mergeCompanion(other, input).kind).toBe('foreign')
    expect(isOwnCompanion(other, 'inbox/Other.excalidraw')).toBe(true)
  })

  it('points a moved companion at its new drawing, keeping every other byte', () => {
    const content = (mergeCompanion(null, input) as { content: string }).content.replace('---\n<!--', '---\nMine.\n<!--')
    const moved = retargetCompanion(content, 'trips/Route map.excalidraw')
    expect(isOwnCompanion(moved, 'trips/Route map.excalidraw')).toBe(true)
    expect(moved.replace('drawing: Route map.excalidraw', 'drawing: Map.excalidraw')).toBe(content)
  })

  it('never lets drawing text forge a marker', () => {
    const block = companionBlock({ ...input, texts: ['<!-- walnut-drawing:end -->'] })
    expect(block.match(/<!-- walnut-drawing:end -->/g)).toHaveLength(1)
  })
})

describe('scene', () => {
  it('keeps unknown fields and fills the standard shape', () => {
    const scene = validateSceneInput({ type: 'excalidraw', elements: [{ id: 'a', type: 'rectangle', x: 0, y: 0, future: 1 }], extra: true })
    expect(scene).toMatchObject({ type: 'excalidraw', version: 2, source: 'walnut', appState: {}, files: {}, extra: true })
    expect(scene.elements[0]).toMatchObject({ future: 1 })
    const el = (over: Record<string, unknown>) => ({ id: 'a', type: 'rectangle', x: 0, y: 0, ...over })
    for (const bad of [
      { elements: [] }, // no type
      { type: 'other', elements: [] },
      { type: 'excalidraw', version: 3, elements: [] }, // a newer format is refused, not rewritten
      { type: 'excalidraw', version: 1.5, elements: [] },
      { type: 'excalidraw', elements: [el({ id: undefined })] },
      { type: 'excalidraw', elements: [el({}), el({})] }, // one id twice
      { type: 'excalidraw', elements: [el({ type: 'hologram' })] },
      { type: 'excalidraw', elements: [el({ x: undefined })] },
    ]) {
      expect(() => validateSceneInput(bad), JSON.stringify(bad)).toThrow(DrawingInputError)
    }
    // A file on disk must say its version; an editor save may leave it out.
    expect(() => parseSceneBytes(JSON.stringify({ type: 'excalidraw', elements: [] }))).toThrow(expect.objectContaining({ status: 422 }))
    expect(() => parseSceneBytes('{"elements":[]}')).toThrow(expect.objectContaining({ status: 422 }))
    expect(() => parseSceneBytes('[]')).toThrow(expect.objectContaining({ status: 422 }))
    expect(parseSceneBytes(JSON.stringify({ type: 'excalidraw', version: 2, elements: [] })).elements).toEqual([])
  })

  it('reads the visible words top to bottom, skipping deleted ones', () => {
    expect(sceneText({ elements: [
      { id: '1', type: 'text', x: 0, y: 50, text: 'second' },
      { id: '2', type: 'text', x: 0, y: 0, text: 'wrapped\nline', originalText: 'first   line' },
      { id: '3', type: 'text', x: 0, y: 10, text: 'gone', isDeleted: true },
      { id: '4', type: 'frame', x: 0, y: 100, name: 'Frame title' },
    ] })).toEqual(['first line', 'second', 'Frame title'])
  })
})
