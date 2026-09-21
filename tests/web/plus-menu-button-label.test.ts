/**
 * The composer's "+" button name (web/src/components/chat/plus-menu-actions.ts):
 * "Add attachment" was the whole truth while the menu only held the image
 * picker; once the caller hands ChatInput any action or toggle row, the label
 * has to promise more than an attachment. The DOM half (the button's aria-label
 * and title on a session composer) is asserted by the Playwright spec.
 */
import { describe, expect, it } from 'vitest'
import { plusButtonLabel, type PlusMenuAction } from '../../web/src/components/chat/plus-menu-actions'

describe('plusButtonLabel', () => {
  it('names the menu "Attachments and more" once the caller adds any row', () => {
    const actions: PlusMenuAction[] = [{ id: 'engine-settings', label: 'Engine settings', onSelect: () => {} }]
    expect(plusButtonLabel(actions.length > 0)).toBe('Attachments and more')
    expect(plusButtonLabel(true)).toBe('Attachments and more')
  })

  it('stays "Add attachment" when plusMenuActions and plusMenuToggles are both empty', () => {
    const actions: PlusMenuAction[] | undefined = undefined
    const toggles: unknown[] = []
    const hasCallerRows = (actions?.length ?? 0) > 0 || toggles.length > 0
    expect(plusButtonLabel(hasCallerRows)).toBe('Add attachment')
    expect(plusButtonLabel(false)).toBe('Add attachment')
  })

  it('a disabled action row still counts as a row (the menu shows it greyed)', () => {
    const actions: PlusMenuAction[] = [{ id: 'x', label: 'Engine settings', disabled: true, title: 'Checking what this engine supports', onSelect: () => {} }]
    expect(plusButtonLabel(actions.length > 0)).toBe('Attachments and more')
  })
})
