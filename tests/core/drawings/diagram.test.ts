/**
 * "Make a diagram" (core/drawings/diagram.ts) with the model call mocked: the picture and the
 * element facts it is sent, the reply checks (a bad reply retried once, then 502), the deadline
 * (504), the input caps (413), and the skeletons that come back (origin at 0,0, arrows bound).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('drawings-diagram'))
const model = vi.hoisted(() => ({ sendMessage: vi.fn() }))
vi.mock('../../../src/model/model.js', () => ({ sendMessage: model.sendMessage }))

import { diagramFacts, diagramTuning, makeDiagram, MAX_DIAGRAM_ELEMENTS, MAX_DIAGRAM_PROMPT, parseDiagramReply } from '../../../src/core/drawings/diagram.js'
import { DrawingInputError, DrawingServiceError, type SceneElement } from '../../../src/core/drawings/scene.js'
import { __setSharpForTests } from '../../../src/utils/image-compress.js'

const reply = (text: string) => ({ content: [{ type: 'text', text }], stopReason: 'end_turn' })
const GOOD = JSON.stringify([
  { id: 'a', type: 'rectangle', x: 100, y: 50, width: 160, height: 60, label: { text: 'Client' } },
  { id: 'b', type: 'diamond', x: 400, y: 50, width: 160, height: 80, text: 'Cached?' },
  { type: 'arrow', x: 0, y: 0, start: { id: 'a' }, end: { id: 'b' }, label: { text: 'asks' } },
  { type: 'text', x: 100, y: 200, text: 'Read path' },
])

const stroke: SceneElement = { id: 's1', type: 'freedraw', x: 10, y: 20, width: 50, height: 40, points: Array.from({ length: 100 }, (_, i) => [i, i % 7]) }
const label: SceneElement = { id: 't1', type: 'text', x: 15, y: 25, text: 'db', originalText: 'db', width: 20, height: 20, containerId: 'r1' }

async function refusal(p: Promise<unknown>): Promise<{ status: number; message: string }> {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err instanceof DrawingInputError || err instanceof DrawingServiceError, String(err)).toBe(true)
  return err as { status: number; message: string }
}

beforeEach(() => {
  model.sendMessage.mockReset()
  diagramTuning.deadlineMs = 150_000
})

afterEach(() => {
  __setSharpForTests(undefined)
})

describe('diagram replies', () => {
  it('turns a good reply into skeletons with labels, bound arrows and the top left at (0,0)', () => {
    const { elements, note } = parseDiagramReply(`Here you go:\n\`\`\`json\n${GOOD}\n\`\`\``)
    expect(note).toBeUndefined()
    expect(elements.map((e) => e.type)).toEqual(['rectangle', 'diamond', 'arrow', 'text'])
    const [a, b, arrow, text] = elements
    expect(a).toMatchObject({ id: 'a', x: 0, y: 0, width: 160, height: 60, label: { text: 'Client' } })
    expect(b).toMatchObject({ id: 'b', x: 300, y: 0, label: { text: 'Cached?' } })
    expect(b).not.toHaveProperty('text')
    expect(arrow).toMatchObject({ type: 'arrow', start: { id: 'a' }, end: { id: 'b' }, label: { text: 'asks' } })
    // The arrow runs between its shapes, not from the (0,0) the model wrote.
    expect(arrow!.x as number).toBeGreaterThan(150)
    expect(Array.isArray(arrow!.points)).toBe(true)
    expect(text).toMatchObject({ x: 0, y: 150, text: 'Read path' })
  })

  it('takes {elements, note}, and refuses replies that are not usable', () => {
    expect(parseDiagramReply(JSON.stringify({ elements: JSON.parse(GOOD), note: 'Left out a scribble.' })).note).toBe('Left out a scribble.')
    for (const bad of ['', 'no json here', '[', '[]', '{"shapes":[]}', '[{"type":"star"}]', '[{"type":"text","x":0,"y":0}]',
      '[{"type":"arrow","x":0,"y":0,"start":{"id":"ghost"}}]', '[{"type":"rectangle","x":1e9,"y":0}]', JSON.stringify(Array.from({ length: 400 }, () => ({ type: 'text', x: 0, y: 0, text: 'x' })))]) {
      expect(() => parseDiagramReply(bad), bad.slice(0, 40)).toThrow()
    }
  })

  it('sends the elements compactly: rounded, labelled, connected, strokes sampled', () => {
    const facts = JSON.parse(diagramFacts([stroke, label, { id: 'r1', type: 'rectangle', x: 0.4, y: 0.6, width: 99.5, height: 50 },
      { id: 'ar', type: 'arrow', x: 0, y: 0, points: [[0, 0], [10, 0]], startBinding: { elementId: 'r1' }, endBinding: { elementId: 's1' } }]))
    expect(facts[0].points.length).toBeLessThanOrEqual(26)
    expect(facts[1]).toEqual({ id: 't1', type: 'text', x: 15, y: 25, w: 20, h: 20, text: 'db', in: 'r1' })
    expect(facts[2]).toEqual({ id: 'r1', type: 'rectangle', x: 0, y: 1, w: 100, h: 50 })
    expect(facts[3]).toMatchObject({ from: 'r1', to: 's1' })
  })
})

describe('makeDiagram', () => {
  it('sends the selection as a picture plus its facts, and answers with the skeletons', async () => {
    const toBuffer = vi.fn(async () => Buffer.from('PNGDATA'))
    const fake = vi.fn(() => ({ resize: () => ({ png: () => ({ toBuffer }) }) }))
    __setSharpForTests(fake as never)
    model.sendMessage.mockResolvedValueOnce(reply(GOOD))
    const result = await makeDiagram({ mode: 'tidy', elements: [stroke, label, { id: 'gone', type: 'rectangle', x: 0, y: 0, isDeleted: true }], taskId: 'task-1' })
    expect(result.elements).toHaveLength(4)
    expect(model.sendMessage).toHaveBeenCalledOnce()
    const call = model.sendMessage.mock.calls[0]![0]
    expect(call.system).toMatch(/ONLY a JSON array/)
    expect(call.purpose).toBe('interactive')
    expect(call.usage).toEqual({ source: 'drawing', taskId: 'task-1' })
    expect(call.config).not.toHaveProperty('model')
    const content = call.messages[0].content
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('PNGDATA').toString('base64') } })
    expect(content[1].text).toContain('"id":"s1"')
    expect(content[1].text).not.toContain('"id":"gone"')
    // The renderer got the SVG of the selection.
    expect(String((fake.mock.calls[0] as unknown[])[0])).toContain('<svg')
  })

  it('still works with no picture when this machine cannot draw one', async () => {
    __setSharpForTests(null)
    model.sendMessage.mockResolvedValueOnce(reply(GOOD))
    await makeDiagram({ mode: 'tidy', elements: [stroke] })
    const content = model.sendMessage.mock.calls[0]![0].messages[0].content
    expect(content.map((c: { type: string }) => c.type)).toEqual(['text'])
  })

  it('uses only the prompt in text mode', async () => {
    model.sendMessage.mockResolvedValueOnce(reply(GOOD))
    await makeDiagram({ mode: 'text', prompt: '  login then dashboard  ', elements: [stroke] })
    expect(model.sendMessage.mock.calls[0]![0].messages[0].content).toEqual([{ type: 'text', text: 'Draw this as a clean diagram:\nlogin then dashboard' }])
  })

  it('asks once more after a bad reply, then answers 502', async () => {
    __setSharpForTests(null)
    model.sendMessage.mockResolvedValueOnce(reply('Sure! Here is a diagram.')).mockResolvedValueOnce(reply(GOOD))
    expect((await makeDiagram({ mode: 'text', prompt: 'a to b' })).elements).toHaveLength(4)
    const retry = model.sendMessage.mock.calls[1]![0].messages
    expect(retry.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(retry[2].content).toMatch(/could not be used: the reply holds no JSON/)

    model.sendMessage.mockReset()
    model.sendMessage.mockResolvedValue(reply('[{"type":"star"}]'))
    const err = await refusal(makeDiagram({ mode: 'text', prompt: 'a to b' }))
    expect(err.status).toBe(502)
    expect(model.sendMessage).toHaveBeenCalledTimes(2)

    model.sendMessage.mockReset()
    model.sendMessage.mockRejectedValue(new Error('provider down'))
    expect(await refusal(makeDiagram({ mode: 'text', prompt: 'a' }))).toMatchObject({ status: 502, message: expect.stringContaining('provider down') })
  })

  it('answers 504 when the model passes the deadline', async () => {
    diagramTuning.deadlineMs = 60
    model.sendMessage.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ content: [], aborted: true }))
    }))
    const started = Date.now()
    expect((await refusal(makeDiagram({ mode: 'text', prompt: 'slow' }))).status).toBe(504)
    expect(Date.now() - started).toBeLessThan(2000)
    model.sendMessage.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    expect((await refusal(makeDiagram({ mode: 'text', prompt: 'slow' }))).status).toBe(504)
  })

  it('refuses bad and oversize input before any model call', async () => {
    expect((await refusal(makeDiagram({ mode: 'draw' }))).status).toBe(400)
    expect((await refusal(makeDiagram({ mode: 'text' }))).status).toBe(400)
    expect((await refusal(makeDiagram({ mode: 'text', prompt: 'x'.repeat(MAX_DIAGRAM_PROMPT + 1) }))).status).toBe(413)
    expect((await refusal(makeDiagram({ mode: 'tidy' }))).status).toBe(400)
    expect((await refusal(makeDiagram({ mode: 'tidy', elements: [] }))).status).toBe(400)
    expect((await refusal(makeDiagram({ mode: 'tidy', elements: Array.from({ length: MAX_DIAGRAM_ELEMENTS + 1 }, (_, i) => ({ ...stroke, id: `s${i}` })) }))).status).toBe(413)
    expect(model.sendMessage).not.toHaveBeenCalled()
  })
})
