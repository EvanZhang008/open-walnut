import { describe, it, expect } from 'vitest'
import { DEFAULT_PIN_SHORTCUTS, firstLevelPinChoices, isPinShortcutList, normalizePinShortcuts, togglePinShortcut, pinShortcutEntries, pinMoreEntries } from '../../web/src/components/tasks/pin-shortcuts'

const choices = [{ value: 'focus' }, { value: 'satellite' }, { value: 'ct_helper' }, { value: 'wait' }, { value: 'unpin' }]

describe('pin shortcut preferences', () => {
  it('defaults to exactly Focus and Satellite and never offers retired choices', () => {
    expect(DEFAULT_PIN_SHORTCUTS).toEqual(['focus', 'satellite'])
    expect(firstLevelPinChoices(choices)).toEqual(choices.slice(0, 3))
    expect(pinShortcutEntries(undefined, firstLevelPinChoices(choices))).toEqual(choices.slice(0, 2))
    expect(pinMoreEntries(undefined, firstLevelPinChoices(choices))).toEqual([choices[2]])
  })
  it.each([null, {}, ['focus', 4], 'focus', true])('wrong-shaped preference %j uses the default', value => {
    expect(isPinShortcutList(value)).toBe(false)
    expect(normalizePinShortcuts(value)).toEqual(['focus', 'satellite'])
  })
  it('an empty choice stays empty, with every tier reachable through More', () => {
    expect(normalizePinShortcuts([])).toEqual([])
    expect(pinShortcutEntries([], firstLevelPinChoices(choices))).toEqual([])
    expect(pinMoreEntries([], firstLevelPinChoices(choices))).toEqual(choices.slice(0, 3))
  })
  it('deduplicates, keeps unavailable custom ids and filters them from rendering', () => {
    const stored = ['focus', '', 'focus', 'ct_loading', 'satellite']
    expect(normalizePinShortcuts(stored)).toEqual(['focus', 'ct_loading', 'satellite'])
    expect(pinShortcutEntries(stored, firstLevelPinChoices(choices))).toEqual(choices.slice(0, 2))
    expect(pinShortcutEntries(stored, [...firstLevelPinChoices(choices), { value: 'ct_loading' }])).toEqual([choices[0], choices[1], { value: 'ct_loading' }])
  })
  it('chooses a custom tier, removes a builtin and retains every other preference', () => {
    const withCustom = togglePinShortcut(undefined, 'ct_helper')
    expect(withCustom).toEqual(['focus', 'satellite', 'ct_helper'])
    expect(togglePinShortcut(withCustom, 'focus')).toEqual(['satellite', 'ct_helper'])
    expect(pinMoreEntries(withCustom, firstLevelPinChoices(choices))).toEqual([])
  })
  it('stored retired wait, backlog and Unpin ids are discarded, not offered again', () => {
    expect(normalizePinShortcuts(['focus', 'wait', 'unpin', 'backlog', 'ct_helper'])).toEqual(['focus', 'ct_helper'])
  })
  it('many plugin shortcuts keep every choice, without an arbitrary cap', () => {
    const plugin = Array.from({ length: 40 }, (_, i) => ({ value: `ct_${i}` }))
    expect(pinShortcutEntries(plugin.map(c => c.value), plugin)).toEqual(plugin)
  })
})
