/**
 * When mod+z is the task undo's (web/src/undo/undo-key.ts): outside text boxes, and in an
 * EMPTY composer (where completing from the keyboard leaves the caret); never in a box with
 * text (that is the text's own undo), a rich editor, a code editor or a terminal.
 */
import { describe, expect, it } from 'vitest'
import { isUndoChord, undoKeyApplies } from '../../web/src/undo/undo-key'

const z = (mods: Partial<KeyboardEvent> = {}) => ({
  key: 'z', code: 'KeyZ', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
  defaultPrevented: false, isComposing: false, ...mods,
}) as KeyboardEvent

/** A minimal element: a tag, classes, a value, and the containers it sits in. */
function el(tag: string, opts: { cls?: string[]; value?: string; editable?: boolean; inside?: string[] } = {}): Element {
  const cls = new Set(opts.cls ?? [])
  return {
    tagName: tag,
    value: opts.value ?? '',
    isContentEditable: !!opts.editable,
    classList: { contains: (c: string) => cls.has(c) },
    closest: (sel: string) => (sel.split(',').map((s) => s.trim().replace(/^\./, '')).some((c) => (opts.inside ?? []).includes(c)) ? ({} as Element) : null),
  } as unknown as Element
}

describe('undo chord', () => {
  it('is Cmd+Z on a Mac and Ctrl+Z elsewhere, never with Shift (redo) or Alt', () => {
    expect(isUndoChord(z({ metaKey: true }), true)).toBe(true)
    expect(isUndoChord(z({ ctrlKey: true }), true)).toBe(false)
    expect(isUndoChord(z({ ctrlKey: true }), false)).toBe(true)
    expect(isUndoChord(z({ metaKey: true, shiftKey: true }), true)).toBe(false)
    expect(isUndoChord(z({ metaKey: true, altKey: true }), true)).toBe(false)
  })
})

describe('who owns mod+z', () => {
  const cmdZ = z({ metaKey: true })
  it('the task undo, when nothing that types has the caret', () => {
    expect(undoKeyApplies(cmdZ, null, true)).toBe(true)
    expect(undoKeyApplies(cmdZ, el('BUTTON'), true)).toBe(true)
    expect(undoKeyApplies(cmdZ, el('DIV'), true)).toBe(true)
  })
  it('the task undo in an empty composer; the text in a composer with text', () => {
    expect(undoKeyApplies(cmdZ, el('TEXTAREA', { cls: ['chat-input-textarea'], value: '' }), true)).toBe(true)
    expect(undoKeyApplies(cmdZ, el('TEXTAREA', { cls: ['chat-input-textarea'], value: 'half a sentence' }), true)).toBe(false)
  })
  it('the field in any other box, even an empty one', () => {
    expect(undoKeyApplies(cmdZ, el('INPUT', { value: '' }), true)).toBe(false)
    expect(undoKeyApplies(cmdZ, el('TEXTAREA', { value: '' }), true)).toBe(false)
    expect(undoKeyApplies(cmdZ, el('SELECT'), true)).toBe(false)
  })
  it('the editor in rich text, code and terminals (xterm\'s hidden textarea is always empty)', () => {
    expect(undoKeyApplies(cmdZ, el('DIV', { editable: true }), true)).toBe(false)
    expect(undoKeyApplies(cmdZ, el('DIV', { inside: ['cm-editor'] }), true)).toBe(false)
    expect(undoKeyApplies(cmdZ, el('TEXTAREA', { cls: ['xterm-helper-textarea'], inside: ['xterm'] }), true)).toBe(false)
  })
  it('nobody, when another handler took the key or an IME is composing', () => {
    expect(undoKeyApplies(z({ metaKey: true, defaultPrevented: true }), null, true)).toBe(false)
    expect(undoKeyApplies(z({ metaKey: true, isComposing: true }), null, true)).toBe(false)
  })
})

describe('snooze toast words', async () => {
  const { formatSnoozeDate } = await import('../../web/src/undo/undo-labels')
  const now = new Date('2026-11-04T09:00:00')
  it('a day for a date, a time for later today, both for another day', () => {
    expect(formatSnoozeDate('2026-11-06', now)).toMatch(/Nov\s*6/)
    expect(formatSnoozeDate(new Date('2026-11-04T15:30:00').toISOString(), now)).toMatch(/3:30/)
    const other = formatSnoozeDate(new Date('2026-11-05T08:00:00').toISOString(), now)
    expect(other).toMatch(/Nov\s*5/)
    expect(other).toMatch(/8:00/)
    expect(formatSnoozeDate('not a date', now)).toBe('not a date')
  })
})
