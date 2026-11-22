/**
 * The shared choice controls (web/src/components/controls/; standard.md, "Choice controls"): each
 * one's markup contract, the ARIA hook its one look reads, and the disabled-and-grey ControlGroup
 * under a master switch. SSR through renderToStaticMarkup, as plus-menu-action-rows.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { createElement as h } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import {
  Tabs, TabList, Tab, Chip, ChipGroup, Checkbox, Radio, DisclosureButton, DisclosureChevron,
  ControlGroup, masterProps, SegmentedControl, ToggleSwitch,
} from '../../web/src/components/controls'

const noop = () => {}
const html = (el: unknown) => renderToStaticMarkup(el as never)

describe('choice controls: one markup per kind', () => {
  it('Tabs: role=tablist, aria-selected on the picked tab, only it in the Tab order, counts muted', () => {
    const out = html(h(Tabs, { value: 'b', onChange: noop, 'aria-label': 'Views', items: [
      { value: 'a', label: 'Chat' }, { value: 'b', label: 'Changes', count: 12, testId: 't-b' }, { value: 'c', label: 'Terminal' },
    ] }))
    expect(out).toMatch(/^<div role="tablist" aria-label="Views" class="wn-tabs">/)
    expect((out.match(/role="tab"/g) ?? []).length).toBe(3)
    expect(out).toContain('aria-selected="true" tabindex="0"')
    expect((out.match(/tabindex="-1"/g) ?? []).length).toBe(2)
    expect(out).toContain('data-testid="t-b"')
    expect(out).toContain('<span class="wn-tab-count">12</span>')
    // The count is its own word in the tab's text and name, never glued to the label.
    expect(out).toContain('Changes <span class="wn-tab-count">12</span>')
  })

  it('Tabs: with nothing picked the first tab takes the Tab key', () => {
    const out = html(h(Tabs, { value: 'z', onChange: noop, 'aria-label': 'V', items: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }))
    expect(out.indexOf('tabindex="0"')).toBeLessThan(out.indexOf('tabindex="-1"'))
  })

  it('TabList + Tab: a close button rides in trailing, the hook class stays, flush drops the line', () => {
    const out = html(h(TabList, { 'aria-label': 'Open notes', flush: true }, h(Tab, { selected: true, className: 'notes-tab', trailing: h('span', { className: 'x' }, 'x') }, 'Note')))
    expect(out).toContain('class="wn-tabs wn-tabs-flush"')
    expect(out).toContain('class="wn-tab is-selected notes-tab"')
    expect(out).toContain('<span class="wn-tab-trailing"><span class="x">x</span></span>')
  })

  it('Chip: aria-pressed, or aria-checked as a radio; the count; a group wraps', () => {
    const on = html(h(Chip, { pressed: true, count: 3 }, 'Needs you'))
    expect(on).toContain('aria-pressed="true"')
    expect(on).toContain('class="wn-chip is-on"')
    expect(on).toContain('<span class="wn-chip-count">3</span>')
    // Its own word in the chip's text and name: "Needs you 3", never "Needs you3" (2026-11-22: a
    // board chip read "Sev 12" for Sev 1 with 2 cards).
    expect(on).toContain('</span> <span class="wn-chip-count">3</span>')
    const radio = html(h(Chip, { pressed: false, role: 'radio' }, 'Week'))
    expect(radio).toContain('role="radio" aria-checked="false"')
    expect(radio).not.toContain('aria-pressed')
    expect(html(h(ChipGroup, { role: 'toolbar' }, h(Chip, { pressed: false }, 'x')))).toMatch(/^<div role="toolbar" class="wn-chips">/)
  })

  it('Checkbox and Radio: the native input drawn by .wn-check; a label makes one row with a detail line', () => {
    const box = html(h(Checkbox, { checked: true, onChange: noop, 'aria-label': 'Pick' }))
    expect(box).toMatch(/^<input type="checkbox"[^>]*class="wn-check"/)
    expect(box).toContain('checked=""')
    const row = html(h(Checkbox, { checked: false, onChange: noop, label: 'Only unread', detail: 'Mail you have not opened' }))
    expect(row).toMatch(/^<label class="wn-check-row">/)
    expect(row).toContain('<span class="wn-check-detail">Mail you have not opened</span>')
    const radio = html(h(Radio, { checked: true, onChange: noop, name: 'host', value: 'a', label: 'This machine' }))
    expect(radio).toContain('type="radio"')
    expect(radio).toContain('name="host"')
    expect(radio).toContain('class="wn-check"')
  })

  it('Disclosure: aria-expanded drives the one chevron rule', () => {
    const out = html(h(DisclosureButton, { expanded: false, trailing: h('span', null, '12') }, 'Closed threads'))
    expect(out).toMatch(/^<button type="button" aria-expanded="false" class="wn-disclosure">/)
    expect(out).toContain('class="wn-disclosure-chevron"')
    expect(html(h(DisclosureChevron, { open: true }))).toContain('wn-disclosure-chevron is-open')
    // The chevron turns by `expanded` itself, so an option row (no aria-expanded) turns it too.
    const option = html(h(DisclosureButton, { expanded: true, role: 'option', 'aria-expanded': undefined }, 'Directors'))
    expect(option).not.toContain('aria-expanded')
    expect(option).toContain('wn-disclosure-chevron is-open')
    // No label: the chevron alone, a small square (a tree row's fold).
    const fold = html(h(DisclosureButton, { expanded: false, 'aria-label': 'Directors under A' }))
    expect(fold).toContain('class="wn-disclosure wn-disclosure-icon"')
    expect(fold).not.toContain('wn-disclosure-label')
  })

  it('SegmentedControl: role=radiogroup, aria-checked on the picked segment, hook classes kept', () => {
    const out = html(h(SegmentedControl, { value: 'w', onChange: noop, 'aria-label': 'Range', options: [{ value: 'd', label: 'Day' }, { value: 'w', label: 'Week' }], fill: true }))
    expect(out).toContain('class="wn-seg settings-segmented wn-seg-fill"')
    expect(out).toMatch(/role="radio" aria-checked="true"[^>]*class="wn-seg-item settings-segment is-selected"/)
  })

  it('ToggleSwitch: role=switch with aria-checked, sm size, names its ControlGroup', () => {
    const out = html(h(ToggleSwitch, { checked: false, onChange: noop, size: 'sm', 'aria-label': 'Triage', ...masterProps('triage-rules') }))
    expect(out).toContain('role="switch" aria-checked="false"')
    expect(out).toContain('aria-controls="triage-rules"')
    expect(out).toContain('class="toggle-switch settings-switch wn-switch-sm"')
  })

  it('ControlGroup: off is a disabled fieldset with its reason; on shows no reason', () => {
    const off = html(h(ControlGroup, { id: 'triage-rules', off: true, reason: 'Turn on Inbox Triage to use its rules.' }, h(ToggleSwitch, { checked: true, onChange: noop, 'aria-label': 'Rule' })))
    expect(off).toMatch(/^<fieldset id="triage-rules" disabled="" data-off="true" class="wn-group">/)
    expect(off).toContain('<p class="wn-group-reason">Turn on Inbox Triage to use its rules.</p>')
    const on = html(h(ControlGroup, { id: 'g', off: false, reason: 'never shown' }, 'x'))
    expect(on).not.toContain('disabled')
    expect(on).not.toContain('never shown')
  })
})
