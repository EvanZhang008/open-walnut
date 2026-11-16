/**
 * The Drawing app's assistant (web/src/components/drawing/DrawingAssistant.tsx): what its agent is
 * told about the drawing, and that every drawing tool it names is one the drawing plugin really
 * registers (a renamed tool would leave the agent reaching for one that is not there).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { drawingAssistantContext, drawingAssistantKey } from '../../web/src/components/drawing/drawing-assistant-context.js'

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
    expect(workspace).toMatch(/const canAssist = place === 'app' && !!currentPath;/)
    expect(workspace).toMatch(/lazy\(\(\) => import\('\.\/DrawingAssistant'\)\)/)
  })

  it("keeps its asks off the board, as the browser side panel's are", () => {
    expect(read('web/src/components/drawing/DrawingAssistant.tsx')).toMatch(/taskMeta: \{ \.\.\.body\.taskMeta, pinTier: null \}/)
  })
})
