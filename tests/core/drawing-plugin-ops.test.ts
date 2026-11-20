import { describe, expect, it, vi } from 'vitest'
import { activate } from '../../plugin-store/walnut-drawing/src/server'
import type { PluginOpDefinition, WalnutServerApi } from '../../packages/plugin-api/src/server'

function setup() {
  const ops: PluginOpDefinition[] = []
  const skill = vi.fn()
  activate({ registry: { op: (op: PluginOpDefinition) => ops.push(op), skill } } as unknown as WalnutServerApi)
  return { ops, skill }
}

describe('Drawing plugin ops', () => {
  it('registers list, read, narration, create, append, render, update and rename as one plugin capability', () => {
    const { ops, skill } = setup()
    expect(ops.map((op) => op.name)).toEqual(['list', 'read', 'narration', 'create', 'append', 'render', 'update', 'rename'])
    expect(ops.every((op) => op.remote === 'allow')).toBe(true)
    expect(ops.filter((op) => op.readonly).map((op) => op.name)).toEqual(['list', 'read', 'narration', 'render'])
    expect(skill).toHaveBeenCalledOnce()
    expect(skill.mock.calls[0][0].id).toBe('drawing')
  })

  it('encodes file paths rather than splicing them into route queries', async () => {
    const { ops } = setup()
    const call = vi.fn().mockResolvedValue({ scene: {}, revision: 'r1' })
    await ops.find((op) => op.name === 'read')!.handler({ path: 'inbox/review & user.excalidraw' }, { call })
    expect(call).toHaveBeenCalledWith('GET', '/api/drawings/file?path=inbox%2Freview%20%26%20user.excalidraw')
  })

  it('read carries the walkthrough overview of a drawing that has one, and nothing else changes without', async () => {
    const { ops } = setup()
    const read = ops.find((op) => op.name === 'read')!
    const call = vi.fn(async (_m: string, url: string) => url.startsWith('/api/drawings/narration')
      ? { path: 'inbox/a.excalidraw', takes: 1, overview: 'Walkthroughs (1) ...' }
      : { path: 'inbox/a.excalidraw', revision: 'r1', scene: {} })
    expect(await read.handler({ path: 'inbox/a.excalidraw' }, { call })).toEqual({ path: 'inbox/a.excalidraw', revision: 'r1', scene: {}, walkthroughs: 'Walkthroughs (1) ...' })
    expect(call).toHaveBeenLastCalledWith('GET', '/api/drawings/narration?path=inbox%2Fa.excalidraw')
    const none = vi.fn(async (_m: string, url: string) => url.startsWith('/api/drawings/narration') ? { takes: 0, overview: '' } : { revision: 'r1' })
    expect(await read.handler({ path: 'inbox/a.excalidraw' }, { call: none })).toEqual({ revision: 'r1' })
    const failing = vi.fn(async (_m: string, url: string) => { if (url.startsWith('/api/drawings/narration')) throw new Error('old server'); return { revision: 'r1' } })
    expect(await read.handler({ path: 'inbox/a.excalidraw' }, { call: failing })).toEqual({ revision: 'r1' })
  })

  it('narration asks for the overview, or one part or span in detail', async () => {
    const { ops } = setup()
    const narration = ops.find((op) => op.name === 'narration')!
    expect(narration.inputSchema?.required).toEqual(['path'])
    const call = vi.fn().mockResolvedValue({ takes: 1 })
    await narration.handler({ path: 'inbox/a & b.excalidraw' }, { call })
    expect(call).toHaveBeenLastCalledWith('GET', '/api/drawings/narration?path=inbox%2Fa+%26+b.excalidraw')
    await narration.handler({ path: 'inbox/a.excalidraw', take: 2, part: 3, from: 'x' }, { call })
    expect(call).toHaveBeenLastCalledWith('GET', '/api/drawings/narration?path=inbox%2Fa.excalidraw&take=2&part=3')
  })

  it('sends only declared list context as query parameters', async () => {
    const { ops } = setup()
    const call = vi.fn().mockResolvedValue({ drawings: [] })
    await ops[0].handler({ taskId: 'task-a', sessionId: 'session-b', path: '/ignored' }, { call })
    expect(call).toHaveBeenCalledWith('GET', '/api/drawings?taskId=task-a&sessionId=session-b')
  })

  it('requires the current revision for additive edits and never offers an overwrite op', async () => {
    const { ops } = setup()
    const append = ops.find((op) => op.name === 'append')!
    expect(append.inputSchema?.required).toEqual(['path', 'revision', 'elements'])
    const call = vi.fn().mockRejectedValue(new Error('Drawing changed since it was read'))
    const args = { path: 'inbox/design.excalidraw', revision: 'old', elements: [{ id: 'new', type: 'rectangle' }] }
    await expect(append.handler(args, { call })).rejects.toThrow('Drawing changed')
    expect(call).toHaveBeenCalledExactlyOnceWith('POST', '/api/drawings/append', args)
    expect(ops.some((op) => /replace|overwrite|save/.test(op.name))).toBe(false)
  })

  it('renders to an image path the agent can look at, with an encoded query', async () => {
    const { ops } = setup()
    const call = vi.fn().mockResolvedValue({ pngPath: '/tmp/x.png' })
    const render = ops.find((op) => op.name === 'render')!
    await render.handler({ path: 'inbox/a & b.excalidraw', format: 'png' }, { call })
    expect(call).toHaveBeenCalledWith('GET', '/api/drawings/render?path=inbox%2Fa+%26+b.excalidraw&format=png')
    await render.handler({ path: 'inbox/a.excalidraw', format: 'jpeg' }, { call })
    expect(call).toHaveBeenLastCalledWith('GET', '/api/drawings/render?path=inbox%2Fa.excalidraw')
  })

  it('edits existing elements only through a revision-checked update', async () => {
    const { ops } = setup()
    const update = ops.find((op) => op.name === 'update')!
    expect(update.inputSchema?.required).toEqual(['path', 'revision'])
    const call = vi.fn().mockResolvedValue({ revision: 'r2' })
    const args = { path: 'inbox/design.excalidraw', revision: 'r1', update: [{ id: 'a', text: 'Review' }], remove: ['s1'], add: [{ id: 'box1', type: 'rectangle' }] }
    await update.handler(args, { call })
    expect(call).toHaveBeenCalledExactlyOnceWith('POST', '/api/drawings/update', args)
  })

  it('renames through the revision-checked rename route', async () => {
    const { ops } = setup()
    const rename = ops.find((op) => op.name === 'rename')!
    expect(rename.readonly).toBe(false)
    expect(rename.inputSchema?.required).toEqual(['path', 'revision', 'title'])
    const call = vi.fn().mockResolvedValue({ path: 'inbox/Login flow.excalidraw', revision: 'r2' })
    const args = { path: 'inbox/Drawing 2026-11-16 09.05.excalidraw', revision: 'r1', title: 'Login flow' }
    await rename.handler(args, { call })
    expect(call).toHaveBeenCalledExactlyOnceWith('POST', '/api/drawings/rename', args)
  })
})
