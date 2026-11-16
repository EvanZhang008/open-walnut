/**
 * The Drawing app's assistant (web/src/components/drawing/DrawingAssistant.tsx): what its agent is
 * told about the drawing, and that every drawing tool it names is one the drawing plugin really
 * registers (a renamed tool would leave the agent reaching for one that is not there).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { drawingAssistantAsk, drawingAssistantContext, drawingAssistantKey, drawingTaskTitle } from '../../web/src/components/drawing/drawing-assistant-context.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

describe('the drawing assistant', () => {
  const context = drawingAssistantContext('Projects/Walnut/System design.excalidraw', 'System design')

  it('remembers one conversation per drawing file', () => {
    expect(drawingAssistantKey('a/b.excalidraw')).toBe('drawing:a/b.excalidraw')
    expect(drawingAssistantKey('a/b.excalidraw')).not.toBe(drawingAssistantKey('a/c.excalidraw'))
  })

  it('names the drawing by the path every drawing tool takes, and asks for an edit in place', () => {
    expect(context).toContain('Drawing path: Projects/Walnut/System design.excalidraw')
    expect(context).toContain('"System design"')
    expect(context).toMatch(/Do not make a new drawing/)
    expect(context).toMatch(/render again and check/)
  })

  it('names only tools the drawing plugin registers', () => {
    const server = read('plugin-store/walnut-drawing/src/server.ts')
    const registered = new Set([...server.matchAll(/name: '([a-z]+)', title:/g)].map((m) => `walnut_drawing_${m[1]}`))
    const named = [...new Set(context.match(/walnut_drawing_[a-z]+/g) ?? [])]
    expect(named.length).toBeGreaterThanOrEqual(3)
    for (const tool of named) expect(registered, tool).toContain(tool)
  })

  it('opens only in the App page, never beside a session, in the composer or in a preview', () => {
    const workspace = read('web/src/components/drawing/DrawingWorkspace.tsx')
    expect(workspace).toMatch(/const canAssist = view\.assistantKey !== null && !!currentPath;/)
    expect(workspace).toMatch(/lazy\(\(\) => import\('\.\/DrawingAssistant'\)\)/)
  })

  it("keeps its asks off the board, as the browser side panel's are", () => {
    expect(read('web/src/components/drawing/DrawingAssistant.tsx')).toMatch(/taskMeta: \{ \.\.\.body\.taskMeta, pinTier: null \}/)
  })
})

describe('a renamed drawing keeps its assistant conversation', () => {
  it('moves the remembered session to the new path, never over one the new path has', async () => {
    const { moveAskSession, readAskSession, writeAskSession } = await import('../../web/src/components/chat/ask-object-session.js')
    const mem = new Map<string, string>()
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v) }, removeItem: (k: string) => { mem.delete(k) } }
    const scope = (p: string) => ({ agentId: 'general', key: drawingAssistantKey(p) })
    writeAskSession(scope('a.excalidraw'), { taskId: 't1', sessionId: 's1', asked: [], at: 1 }, storage)
    moveAskSession(scope('a.excalidraw'), scope('b.excalidraw'), storage)
    expect(readAskSession(scope('b.excalidraw'), storage)?.sessionId).toBe('s1')
    expect(readAskSession(scope('a.excalidraw'), storage)).toBeNull()
    // The new path already has its own: kept, and the old one is let go.
    writeAskSession(scope('c.excalidraw'), { taskId: 't2', sessionId: 's2', asked: [], at: 1 }, storage)
    writeAskSession(scope('d.excalidraw'), { taskId: 't3', sessionId: 's3', asked: [], at: 1 }, storage)
    moveAskSession(scope('c.excalidraw'), scope('d.excalidraw'), storage)
    expect(readAskSession(scope('d.excalidraw'), storage)?.sessionId).toBe('s3')
  })

  it('is followed by the workspace for one controller only (another drawing opened is not a rename)', () => {
    const workspace = read('web/src/components/drawing/DrawingWorkspace.tsx')
    expect(workspace).toMatch(/before\.controller === controller && before\.path && path && before\.path !== path\) followDrawingRename\(before\.path, path\)/)
  })

  it('Escape in the chat hands the keys back to the drawing, and an Escape elsewhere is left alone', () => {
    expect(read('web/src/components/drawing/DrawingAssistant.tsx')).toMatch(/onClose=\{\(\) => \{ if \(panel\.current\?\.contains\(document\.activeElement\)\) onLeave\(\); \}\}/)
  })
})

describe("the editor's diagram asks go to the drawing's own session", () => {
  it('names the selected shapes by id, or the whole drawing, or the typed description', () => {
    expect(drawingAssistantAsk({ kind: 'tidy', selectedIds: ['a1', 'b2'] })).toMatch(/^Make a diagram from the shapes I selected \(element ids: a1, b2\)\. Look at it first/)
    expect(drawingAssistantAsk({ kind: 'tidy', selectedIds: null })).toMatch(/^Make a diagram from this whole drawing\./)
    expect(drawingAssistantAsk({ kind: 'text', prompt: '  order calls payment  ' })).toMatch(/^Text to diagram: .*\n\norder calls payment$/)
    // A big selection stays a short message.
    const many = Array.from({ length: 75 }, (_, i) => `id${i}`)
    const text = drawingAssistantAsk({ kind: 'tidy', selectedIds: many })
    expect(text).toContain('id59 and 15 more)')
    expect(text).not.toContain('id60,')
  })

  it("names the drawing's task after the drawing", () => {
    expect(drawingTaskTitle('Order review')).toBe('Drawing: Order review')
    expect(drawingTaskTitle('  ')).toBe('Drawing: Untitled')
  })

  it('the App page routes Make a diagram and Text to diagram to the assistant, other places keep the one call', () => {
    const workspace = read('web/src/components/drawing/DrawingWorkspace.tsx')
    const make = workspace.slice(workspace.indexOf('const makeDiagram = async'))
    expect(make.indexOf('if (canAssist) {')).toBeGreaterThan(0)
    expect(make.indexOf('if (canAssist) {')).toBeLessThan(make.indexOf('requestDiagram('))
    expect(make).toMatch(/setAssistantRequest\(\{ id: assistantAsks\.current, text \}\)/)
    const assistant = read('web/src/components/drawing/DrawingAssistant.tsx')
    expect(assistant).toMatch(/sendSessionMessage\(\{ sessionId: record\.sessionId, message: request\.text \}\)/)
    expect(assistant).toMatch(/updateTask\(taskId, \{ title: drawingTaskTitle\(title\) \}\)/)
  })
})
