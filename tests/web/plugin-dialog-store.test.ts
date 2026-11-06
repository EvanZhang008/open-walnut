import { afterEach, describe, expect, it, vi } from 'vitest'
import { closePluginDialog, getPluginDialog, getPluginDialogOpener, invalidatePluginDialog, isDialogNavigationPath, openPluginDialog, pluginDialogSlot, subscribePluginDialog } from '../../web/src/plugins/dialog-store'

afterEach(() => { const open = getPluginDialog(); if (open) closePluginDialog(open.sequence) })

describe('plugin dialog lifecycle', () => {
  it('copies args, preserves form identity on duplicates and refuses replacement', () => {
    const listener = vi.fn()
    const unsubscribe = subscribePluginDialog(listener)
    const args = { record: 'one', nested: { value: 1 } }
    expect(openPluginDialog('sample', 'record', args)).toBe(true)
    const first = getPluginDialog()!
    args.nested.value = 2
    expect(first.args).toEqual({ record: 'one', nested: { value: 1 } })
    expect(openPluginDialog('sample', 'record', { record: 'two' })).toBe(true)
    expect(getPluginDialog()).toBe(first)
    expect(openPluginDialog('other', 'record')).toBe(false)
    expect(openPluginDialog('sample', 'other')).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('captures the opener once, keeps it on invalidation and releases it on close', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const opener = {} as Element
    try {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: opener } })
      openPluginDialog('sample', 'record', { transient: 'value' })
      const first = getPluginDialog()!
      expect(getPluginDialogOpener(first.sequence)).toBe(opener)
      expect(first).not.toHaveProperty('opener')
      Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: {} } })
      openPluginDialog('sample', 'record')
      invalidatePluginDialog(first.sequence)
      expect(getPluginDialogOpener(first.sequence)).toBe(opener)
      expect(getPluginDialogOpener(first.sequence + 1)).toBeNull()
      closePluginDialog(first.sequence)
      expect(getPluginDialogOpener(first.sequence)).toBeNull()
    } finally {
      if (original) Object.defineProperty(globalThis, 'document', original)
      else Reflect.deleteProperty(globalThis, 'document')
    }
  })

  it('releases args on invalidation and ignores stale close or invalidation callbacks', () => {
    openPluginDialog('sample', 'record', { transient: 'value' })
    const first = getPluginDialog()!
    invalidatePluginDialog(first.sequence)
    expect(getPluginDialog()).toEqual({ sequence: first.sequence, pluginId: 'sample', slot: 'record', unavailable: true })
    expect(openPluginDialog('sample', 'record')).toBe(false)
    closePluginDialog(first.sequence)
    expect(getPluginDialog()).toBeNull()
    openPluginDialog('sample', 'record')
    const second = getPluginDialog()
    closePluginDialog(first.sequence)
    invalidatePluginDialog(first.sequence)
    expect(getPluginDialog()).toBe(second)
  })

  it.each(['', '../record', 'other:record', 'https://example.com', 'a/b'])('rejects nonlocal ids: %s', id => {
    expect(openPluginDialog('sample', id)).toBe(false)
    expect(openPluginDialog(id, 'record')).toBe(false)
    expect(getPluginDialog()).toBeNull()
  })

  it('selects only the requested owner, local id and dialog target', () => {
    const component = () => null
    const slots = [
      { key: 'other:record', pluginId: 'other', pluginName: 'Other', generation: 1, value: { id: 'record', target: 'dialog' as const, title: 'Other', component } },
      { key: 'sample:wrong', pluginId: 'sample', pluginName: 'Sample', generation: 2, value: { id: 'wrong', target: 'dialog' as const, title: 'Wrong', component } },
      { key: 'sample:record', pluginId: 'sample', pluginName: 'Sample', generation: 3, value: { id: 'record', target: 'task.meta' as const, title: 'Fact', component } },
    ]
    expect(pluginDialogSlot(slots, 'sample', 'record')).toBeUndefined()
    const right = { ...slots[2], generation: 4, value: { ...slots[2].value, target: 'dialog' as const } }
    expect(pluginDialogSlot([...slots, right], 'sample', 'record')).toBe(right)
  })

  it('rejects malformed or uncloneable arguments', () => {
    expect(openPluginDialog('sample', 'record', [] as never)).toBe(false)
    expect(openPluginDialog('sample', 'record', { callback: () => {} })).toBe(false)
    expect(getPluginDialog()).toBeNull()
  })

  it.each(['/apps/sample~main', '/settings#plugins', '/tasks/one?tab=files', '/apps/sample~main?url=https%3A%2F%2Fexample.com'])('accepts console navigation: %s', path => {
    expect(isDialogNavigationPath(path)).toBe(true)
  })

  it.each(['https://example.com', '//example.com', '/\\example.com', '/\n/example.com', 'javascript:alert(1)', '/%2fexample.com', '/a/../b', '/a/%2e%2e/b', '/a/.%2e/b', '/bad%zz'])('rejects external or unsafe navigation: %s', path => {
    expect(isDialogNavigationPath(path)).toBe(false)
  })
})
