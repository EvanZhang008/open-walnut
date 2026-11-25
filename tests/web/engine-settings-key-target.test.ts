/**
 * keyTargetOf and refocusAfterSave (web/src/components/sessions/engine-settings-popover-focus.ts): the
 * control a key in the engine settings popover is for, and where the focus goes when a save ends. A save disables its row's controls through a native
 * <fieldset disabled>, and the browser drops the focus to <body> under the user (2026-11-25: in
 * WebKit an arrow key on a closed select saves at once, and the Escape meant for the select closed
 * the whole dialog). Every kind of control a row draws must keep its keys through its own save, so
 * the kinds are read from EngineSettingRows.tsx: a new kind fails here until it is listed below. A
 * finished save moves the focus only when the save took it away, never from where he put it (the
 * composer an outside click focused, the dialog an Escape stepped out to).
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { keyTargetOf, refocusAfterSave, type FocusAtSaveEnd, type KeyNode } from '../../web/src/components/sessions/engine-settings-popover-focus'

interface FakeNode extends KeyNode { name: string; disabled: boolean }
const node = (name: string, disabled = false): FakeNode => ({ name, disabled, matches: (sel) => sel === ':disabled' && disabled })

function dialogWith(...inside: FakeNode[]) {
  const set = new Set<FakeNode | null>(inside)
  return { contains: (n: FakeNode | null) => set.has(n) }
}

/** The control kinds a row draws (the JSX tags in EngineSettingRows.tsx). */
const ROW_CONTROL_KINDS = ['select', 'input', 'button'] as const

describe('keyTargetOf', () => {
  it('lists every control kind a row draws', () => {
    const src = fs.readFileSync(new URL('../../web/src/components/settings/sections/EngineSettingRows.tsx', import.meta.url), 'utf8')
    const drawn = new Set([...src.matchAll(/<(select|input|button|textarea|details|summary|a)\b/g)].map((m) => m[1]))
    expect([...drawn].sort()).toEqual([...ROW_CONTROL_KINDS].sort())
  })

  for (const kind of ROW_CONTROL_KINDS) {
    it(`a ${kind} its own save disabled keeps the key while the focus is on the page`, () => {
      const control = node(kind, true)
      const body = node('body')
      expect(keyTargetOf(dialogWith(control), body, control, body)).toBe(control)
    })
  }

  it('the focused element inside the dialog is the target', () => {
    const select = node('select')
    const filter = node('filter')
    expect(keyTargetOf(dialogWith(select, filter), filter, select, null)).toBe(filter)
  })

  it('once the save is over the control no longer owns a key pressed on the page', () => {
    const select = node('select', false)
    const body = node('body')
    expect(keyTargetOf(dialogWith(select), body, select, body)).toBe(body)
  })

  it('focus the user put outside the dialog keeps its key, even while a save disables the control', () => {
    const select = node('select', true)
    const body = node('body')
    const composer = node('composer')
    expect(keyTargetOf(dialogWith(select), composer, select, body)).toBe(composer)
  })

  it('a control outside the dialog (an earlier open) is never the target', () => {
    const stale = node('select', true)
    const body = node('body')
    expect(keyTargetOf(dialogWith(), body, stale, body)).toBe(body)
    expect(keyTargetOf(dialogWith(), null, null, null)).toBeNull()
  })
})

describe('refocusAfterSave', () => {
  // Every place the focus can be when a save ends; the Record fails to compile when a place is added.
  const expected: Record<FocusAtSaveEnd, { fresh: boolean; steppedOut: boolean }> = {
    page: { fresh: true, steppedOut: true },
    dialog: { fresh: true, steppedOut: false },
    control: { fresh: false, steppedOut: false },
    elsewhere: { fresh: false, steppedOut: false },
  }
  for (const [at, want] of Object.entries(expected) as Array<[FocusAtSaveEnd, { fresh: boolean; steppedOut: boolean }]>) {
    it(`focus on the ${at}: ${want.fresh ? 'back to the row' : 'stays'}${want.steppedOut !== want.fresh ? ', and stays after an Escape out of a select' : ''}`, () => {
      expect(refocusAfterSave(at, false)).toBe(want.fresh)
      expect(refocusAfterSave(at, true)).toBe(want.steppedOut)
    })
  }
})
