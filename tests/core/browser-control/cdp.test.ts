/**
 * Real input for agents (packages/browser-extension/src/cdp.ts): the exact debugger commands
 * each action sends, with a fake chrome.debugger. The debugger is attached for the one action
 * and always detached after, also when a command fails; a tab DevTools holds says so.
 */
import { describe, expect, it } from 'vitest'
import {
  CdpError, EVAL_MAX, cdpClick, cdpDialog, cdpEvaluate, cdpHover, cdpPress, cdpType, cdpUpload, parseCombo, withDebugger,
} from '../../../packages/browser-extension/src/cdp'

function fakeDebugger(answers: Record<string, unknown | ((p: Record<string, unknown>) => unknown)> = {}, opts: { attachFails?: string } = {}) {
  const log: Array<[string, Record<string, unknown>?]> = []
  const dbg = {
    attach: async (t: { tabId: number }, v: string) => { log.push(['attach', { tabId: t.tabId, v }]); if (opts.attachFails) throw new Error(opts.attachFails) },
    detach: async (t: { tabId: number }) => { log.push(['detach', { tabId: t.tabId }]) },
    sendCommand: async (_t: { tabId: number }, method: string, params?: Record<string, unknown>) => {
      log.push([method, params])
      const a = answers[method]
      if (a instanceof Error) throw a
      return typeof a === 'function' ? (a as (p: Record<string, unknown>) => unknown)(params ?? {}) : a ?? {}
    },
  }
  return { dbg, log, methods: () => log.map((l) => l[0]) }
}

describe('withDebugger', () => {
  it('attaches for the one action and detaches right after', async () => {
    const f = fakeDebugger()
    await withDebugger(f.dbg, 7, (send) => cdpClick(send, 10, 20))
    expect(f.log[0]).toEqual(['attach', { tabId: 7, v: '1.3' }])
    expect(f.log[f.log.length - 1]).toEqual(['detach', { tabId: 7 }])
  })

  it('detaches when a command fails', async () => {
    const f = fakeDebugger({ 'Input.dispatchMouseEvent': new Error('boom') })
    await expect(withDebugger(f.dbg, 3, (send) => cdpClick(send, 1, 1))).rejects.toThrow('boom')
    expect(f.methods()).toEqual(['attach', 'Input.dispatchMouseEvent', 'detach'])
  })

  it('a tab another debugger holds is refused as debugger_busy, and nothing is sent', async () => {
    const f = fakeDebugger({}, { attachFails: 'Another debugger is already attached to the tab with id: 3.' })
    const err = await withDebugger(f.dbg, 3, (send) => cdpClick(send, 1, 1)).catch((e) => e)
    expect(err).toBeInstanceOf(CdpError)
    expect(err.code).toBe('debugger_busy')
    expect(f.methods()).toEqual(['attach'])
  })
})

describe('the command sequences', () => {
  it('click: move, press, release at the point', async () => {
    const f = fakeDebugger()
    await withDebugger(f.dbg, 1, (send) => cdpClick(send, 100.5, 40))
    expect(f.log.slice(1, -1)).toEqual([
      ['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100.5, y: 40 }],
      ['Input.dispatchMouseEvent', { type: 'mousePressed', x: 100.5, y: 40, button: 'left', clickCount: 1, buttons: 1 }],
      ['Input.dispatchMouseEvent', { type: 'mouseReleased', x: 100.5, y: 40, button: 'left', clickCount: 1, buttons: 0 }],
    ])
  })

  it('hover: one move', async () => {
    const f = fakeDebugger()
    await withDebugger(f.dbg, 1, (send) => cdpHover(send, 5, 6))
    expect(f.log.slice(1, -1)).toEqual([['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 6 }]])
  })

  it('type: a key down and up per character, Enter for a new line, text beyond ASCII as it is', async () => {
    const f = fakeDebugger()
    await withDebugger(f.dbg, 1, (send) => cdpType(send, 'a1\né'))
    expect(f.log.slice(1, -1)).toEqual([
      ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a', modifiers: 0 }],
      ['Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0 }],
      ['Input.dispatchKeyEvent', { type: 'keyDown', key: '1', code: 'Digit1', windowsVirtualKeyCode: 49, text: '1', modifiers: 0 }],
      ['Input.dispatchKeyEvent', { type: 'keyUp', key: '1', code: 'Digit1', windowsVirtualKeyCode: 49, modifiers: 0 }],
      ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', modifiers: 0 }],
      ['Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0 }],
      ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'é', text: 'é', modifiers: 0 }],
      ['Input.dispatchKeyEvent', { type: 'keyUp', key: 'é', modifiers: 0 }],
    ])
  })

  it('press: a shortcut sends no text and carries its modifiers; a named key has its code', async () => {
    const f = fakeDebugger()
    await withDebugger(f.dbg, 1, async (send) => { await cdpPress(send, 'Control+a'); await cdpPress(send, 'Tab') })
    expect(f.log.slice(1, -1)).toEqual([
      ['Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }],
      ['Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }],
      ['Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 0 }],
      ['Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 0 }],
    ])
    expect(parseCombo('Meta+Shift+K')).toEqual({ key: 'K', modifiers: 12 })
    // Shift with a letter types the capital.
    const g = fakeDebugger()
    await withDebugger(g.dbg, 1, (send) => cdpPress(send, 'Shift+a'))
    expect(g.log[1]).toEqual(['Input.dispatchKeyEvent', { type: 'keyDown', key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'A', modifiers: 8 }])
    expect(parseCombo('+')).toEqual({ key: '+', modifiers: 0 })
    expect(() => parseCombo('Hyper+a')).toThrow(/Unknown modifier/)
  })

  it('dialog: answers the open one; none open says no_dialog', async () => {
    const f = fakeDebugger()
    await withDebugger(f.dbg, 1, (send) => cdpDialog(send, false, 'my answer'))
    expect(f.log.slice(1, -1)).toEqual([['Page.enable', {}], ['Page.handleJavaScriptDialog', { accept: false, promptText: 'my answer' }]])
    const g = fakeDebugger({ 'Page.handleJavaScriptDialog': new Error('No dialog is showing') })
    const err = await withDebugger(g.dbg, 1, (send) => cdpDialog(send, true)).catch((e) => e)
    expect(err.code).toBe('no_dialog')
    expect(g.methods()[g.methods().length - 1]).toBe('detach')
  })

  it('evaluate: the value by value, a failure as eval_error, a long result cut at 50 KB', async () => {
    const f = fakeDebugger({ 'Runtime.evaluate': { result: { type: 'object', value: { title: 'Shop', n: 2 } } } })
    expect(await withDebugger(f.dbg, 1, (send) => cdpEvaluate(send, '({ title: document.title, n: 2 })'))).toEqual({ value: { title: 'Shop', n: 2 }, type: 'object' })
    expect(f.log[1]).toEqual(['Runtime.evaluate', { expression: '({ title: document.title, n: 2 })', returnByValue: true, awaitPromise: true, userGesture: true, timeout: 10_000 }])
    const g = fakeDebugger({ 'Runtime.evaluate': { exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: nope is not defined' } } } })
    const err = await withDebugger(g.dbg, 1, (send) => cdpEvaluate(send, 'nope')).catch((e) => e)
    expect(err.code).toBe('eval_error')
    expect(err.message).toContain('ReferenceError')
    const h = fakeDebugger({ 'Runtime.evaluate': { result: { type: 'string', value: 'x'.repeat(EVAL_MAX + 10) } } })
    const big = await withDebugger(h.dbg, 1, (send) => cdpEvaluate(send, 'big'))
    expect(big.cut).toBe(true)
    expect(big.json).toHaveLength(EVAL_MAX)
  })

  it('upload: finds the marked file input and sets the paths', async () => {
    const f = fakeDebugger({ 'DOM.getDocument': { root: { nodeId: 1 } }, 'DOM.querySelector': { nodeId: 42 } })
    await withDebugger(f.dbg, 1, (send) => cdpUpload(send, 'abc123', ['/home/me/a.pdf']))
    expect(f.log.slice(1, -1)).toEqual([
      ['DOM.getDocument', { depth: 0 }],
      ['DOM.querySelector', { nodeId: 1, selector: '[data-walnut-upload="abc123"]' }],
      ['DOM.setFileInputFiles', { nodeId: 42, files: ['/home/me/a.pdf'] }],
    ])
    const g = fakeDebugger({ 'DOM.getDocument': { root: { nodeId: 1 } }, 'DOM.querySelector': { nodeId: 0 } })
    expect((await withDebugger(g.dbg, 1, (send) => cdpUpload(send, 'abc123', ['/x'])).catch((e) => e)).code).toBe('stale_ref')
  })
})
