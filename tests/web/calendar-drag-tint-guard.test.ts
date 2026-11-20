/**
 * Every block a calendar drag shows is drawn in the colour the item has once dropped
 * (web/src/components/calendar/item-tint.ts). 2026-11-20: a new event dragged out on the
 * homepage agenda was the accent blue under the mouse and its calendar's purple once let go;
 * the move ghost, the resize ghost and the month view's cursor chip each picked a colour of
 * their own the same way.
 *
 * The class: an element of the calendar views that previews an item (a ghost, the block being
 * created, the chip under the cursor). Each one found in the source must set `--cal-chip-tint`
 * in its own tag, and every file that sets the tint takes it from item-tint.ts, so a new
 * preview cannot quietly fall back to the stylesheet's accent.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { chipTint, newEventCalendars } from '../../web/src/components/calendar/item-tint'
import type { CalendarItem } from '../../web/src/components/calendar/calendar-items'

const root = path.resolve(import.meta.dirname, '../..')
const DIR = path.join(root, 'web/src/components/calendar')
const sources = fs.readdirSync(DIR).filter((f) => f.endsWith('.tsx'))
  .map((f) => ({ file: f, text: fs.readFileSync(path.join(DIR, f), 'utf8') }))

/** Class names that mark an element as a preview of an item. */
const PREVIEW = /\b(cal-move-ghost|cal-drag-cursor-chip|cal-create-sel|cal-create-placeholder|[\w-]*ghost[\w-]*|[\w-]*cursor-chip[\w-]*)\b/

/** Each JSX opening tag (from `<div` to its closing `>`) whose className names a preview class. */
function previewTags(text: string): string[] {
  const tags: string[] = []
  const open = /<(div|span)\b/g
  let m: RegExpExecArray | null
  while ((m = open.exec(text))) {
    // The tag ends at the first `>` outside braces.
    let depth = 0
    let end = m.index
    for (let i = m.index; i < text.length; i++) {
      const c = text[i]
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) { end = i; break }
    }
    const tag = text.slice(m.index, end + 1)
    const cls = /className=(\{`[^`]*`\}|"[^"]*"|\{[^}]*\})/.exec(tag)?.[1] ?? ''
    // Not previews: the chip itself faded in place (`cal-chip-ghosted`), and a preview's own
    // title or time line inside it (it inherits the tint).
    const tokens = cls.split(/[^\w-]+/).filter((t) => t && t !== 'cal-chip-ghosted' && !/-(title|time)$/.test(t))
    if (tokens.some((t) => PREVIEW.test(t))) tags.push(tag)
  }
  return tags
}

describe('calendar drag previews take the item\'s own tint', () => {
  it('finds the known previews (so the scan itself still works)', () => {
    const all = sources.flatMap(({ text }) => previewTags(text))
    // Move ghost, resize ghost, create selection (TimeGrid); cursor chip (MonthView); placeholder (QuickCreatePopover).
    expect(all.length).toBeGreaterThanOrEqual(5)
  })

  it('every preview element sets --cal-chip-tint in its own tag', () => {
    const missing = sources.flatMap(({ file, text }) => previewTags(text)
      .filter((tag) => !tag.includes("'--cal-chip-tint'"))
      .map((tag) => `${file}: ${tag.slice(0, 120).replace(/\s+/g, ' ')}`))
    expect(missing).toEqual([])
  })

  it('every file that sets the tint takes it from item-tint.ts', () => {
    const offenders = sources
      .filter(({ text }) => text.includes("'--cal-chip-tint'"))
      .filter(({ text }) => !/from '\.\/item-tint'/.test(text))
      .map(({ file }) => file)
    expect(offenders).toEqual([])
  })
})

describe('chipTint', () => {
  const ev = (color?: string) => ({ kind: 'event', event: { color } }) as unknown as CalendarItem
  it('is the calendar colour for an event, red for a deadline, the accent otherwise', () => {
    expect(chipTint(ev('#af52de'))).toBe('#af52de')
    expect(chipTint(ev())).toBe('var(--accent)')
    expect(chipTint({ kind: 'task-due' } as unknown as CalendarItem)).toBe('var(--error)')
    expect(chipTint({ kind: 'task-start' } as unknown as CalendarItem)).toBe('var(--accent)')
  })
})

describe('newEventCalendars (the form and the drag both start on it)', () => {
  const cal = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, account: 'a', color: `#${id}`, readonly: false, hidden: false, ...extra })
  it('starts on the configured default, not the first listed', () => {
    const r = newEventCalendars([cal('111111'), cal('222222')], { id: '222222', configuredId: '222222' })
    expect(r.preselect?.id).toBe('222222')
    expect(r.warning).toBeNull()
  })
  it('falls back to the first writable one when none is configured; never a read-only one', () => {
    const r = newEventCalendars([cal('000000', { readonly: true }), cal('111111')], { id: null, configuredId: null })
    expect(r.preselect?.id).toBe('111111')
    expect(r.writable.map((c) => c.id)).toEqual(['111111'])
  })
  it('a hidden default stays pickable; an unusable configured default picks nothing and says why', () => {
    expect(newEventCalendars([cal('111111', { hidden: true })], { id: '111111', configuredId: '111111' }).preselect?.id).toBe('111111')
    const r = newEventCalendars([cal('111111')], { id: null, configuredId: 'gone', warning: 'It is gone.' })
    expect(r).toMatchObject({ preselect: null, warning: 'It is gone.' })
  })
})
