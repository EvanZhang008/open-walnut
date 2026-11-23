/**
 * A picker shows its current item by colour, never by a checkmark (2026-11-14, the user:
 * "why must there be a checkmark ... just show the name, and colour the selected one").
 * The shared look is the Picked row (standard.md, "Choice controls"; styles/pick-and-nav.css):
 * the row carries `wn-pick-row` and its ARIA state, and its name turns --accent-text.
 * This reads every web component (and the plugins' web code) and fails when one draws a
 * checkmark beside a selectable row again: a glyph or ICON_CHECK switched on a condition, a lone
 * glyph in a span, an element whose class ends in "-check", or the retired PickMark
 * (`wn-pick-mark`), or a stylesheet that shows a "-check" element on a selected row. An on/off
 * setting is a switch, or in a menu a row coloured like a pick. A real checkbox, and a mark that says a step is
 * done, are listed below with why.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../..')
const DIRS = ['web/src/components', 'web/src/apps', 'web/src/pages', 'plugin-store', 'examples/plugins']
/** Not a picker's current choice: each line says what it is. */
const ALLOWED: Record<string, RegExp[]> = {
  // A multi-select checkbox on a task card (role="checkbox"), as in the main task list.
  'web/src/components/tasks/FocusSatelliteCards.tsx': [/isSelected \? '✓' : ''/],
  // The main task list's multi-select checkbox (role="checkbox").
  'web/src/components/tasks/TodoPanel.tsx': [/isSelected \? ICONS\.ICON_CHECK : null/],
  // "Unsubscribed" done mark on a mail line: a finished step, nothing to choose.
  'web/src/apps/mail/MailReaderHead.tsx': [/mail-reader-unsub-check/],
  // The "permission granted" badge of the fix dialog: a finished step.
  'web/src/components/common/PermissionFixDialog.tsx': [/permission-granted-check/],
  // A copy button's "copied" mark: a finished step.
  'web/src/components/common/CopyButton.tsx': [/copied \? ICON_CHECK : ICON_COPY/],
  // A checklist's checkbox square (fb-check-box, drawn only for multi-select rows; a single-select
  // row is a Picked row).
  'web/src/components/tasks/FilterValueList.tsx': [/on \? ICON_CHECK : sel === 'mixed'/],
}

const SELECTION_MARK = [
  /\?\s*['"`][✓✔]['"`]\s*:\s*(['"`]{2}|null|undefined)/, // {on ? '✓' : ''}
  /&&\s*(<span[^>]*>)?\s*['"`]?[✓✔]/, // {on && <span>✓</span>}
  /<span className="[^"]*-check"[^>]*>\s*[✓✔]\s*</, // <span className="x-check">✓</span>
  /<span className="[^"]*-check"\s*\/>/, // the empty column kept for one
  /\?\s*(ICONS\.)?ICON_CHECK\s*:/, // {on ? ICON_CHECK : null}
  /&&\s*(<span[^>]*>\s*)?\{?\s*(ICONS\.)?ICON_CHECK\b/, // {on && <span>{ICON_CHECK}</span>}
  /wn-pick-mark/, // the retired PickMark's class
  /\bPickMark\b/, // the retired PickMark component
]

/** A rule that styles an element named "-check" under a selected, checked, pressed or current row. */
const SHOWN_CHECK = /\[aria-(selected|checked|pressed|current)=['"]true['"]\][^{,]*\.[a-z0-9-]*-check\b/
/** Real checkboxes drawn in CSS: each line says what it is. */
const ALLOWED_CSS = [
  // The calendar list's checkbox squares (show or hide each calendar; several at once).
  /\.cal-cals-row\[aria-checked='true'\] \.cal-cals-check/,
]

function cssFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === 'dist') return []
    const full = path.join(dir, e.name)
    return e.isDirectory() ? cssFiles(full) : /\.css$/.test(e.name) ? [full] : []
  })
}

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === 'dist') return []
    const full = path.join(dir, e.name)
    return e.isDirectory() ? files(full) : /\.tsx$/.test(e.name) ? [full] : []
  })
}

function marks(): string[] {
  const found: string[] = []
  for (const dir of DIRS) {
    if (!fs.existsSync(path.join(ROOT, dir))) continue
    for (const file of files(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file)
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (!SELECTION_MARK.some((re) => re.test(line))) return
        if (ALLOWED[rel]?.some((re) => re.test(line))) return
        found.push(`${rel}:${i + 1}: ${line.trim()}`)
      })
    }
  }
  return found
}

describe('pickers show the current item by colour', () => {
  it('no component draws a selection checkmark', () => {
    expect(marks(), 'show the picked row with wn-pick-row and its ARIA state (pick-and-nav.css), not a checkmark').toEqual([])
  })

  it('the patterns catch a check mark in each form', () => {
    const hit = (line: string) => SELECTION_MARK.some((re) => re.test(line))
    expect(hit(`<span className="x" aria-hidden>{picked ? ICON_CHECK : null}</span>`)).toBe(true)
    expect(hit(`{active && <span className="x">{ICON_CHECK}</span>}`)).toBe(true)
    expect(hit(`<PickMark on={picked} />`)).toBe(true)
    expect(hit(`<span className="wn-pick-mark" data-on="true">`)).toBe(true)
    expect(hit(`{on ? '✓' : ''}`)).toBe(true)
    // A done mark that is always shown is not a pick.
    expect(hit(`<span aria-hidden="true">{ICON_CHECK}</span> Complete`)).toBe(false)
  })

  it('the pickers that had one keep their rows marked for colour and for assistive tech', () => {
    const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')
    const sessions = (f: string) => read(`web/src/components/sessions/${f}`)
    // One row component for the model, effort and permission-mode pickers: a wn-pick-row option.
    expect(sessions('PickerRow.tsx')).toMatch(/wn-pick-row/)
    expect(sessions('PickerRow.tsx')).toMatch(/aria-selected=\{[^}]*\bpicked\}/)
    // A browse list (the Provider column): aria-selected is the browsed row, aria-current the
    // row holding the current value, so screen readers and the fill agree.
    expect(sessions('PickerRow.tsx')).toMatch(/aria-current=\{browse && current/)
    expect(sessions('ModelPicker.tsx')).toMatch(/browsed=\{isSelected\}\s+current=\{holdsActive\}/)
    expect(read('web/src/styles/pick-and-nav.css')).toMatch(/aria-selected='true'\]:not\(\[data-pick='browse'\]\)/)
    expect(sessions('ModelPicker.tsx')).toContain('<PickerRow')
    expect(sessions('PermissionModeMenu.tsx')).toContain('<PickerRow')
    expect(sessions('SessionControlPills.tsx')).toMatch(/session-control-option wn-pick-row/)
    for (const f of ['PickerRow.tsx', 'ModelPicker.tsx', 'SessionControlPills.tsx', 'DiffComparePicker.tsx']) {
      expect(sessions(f), f).toMatch(/aria-selected/)
    }
    // The rhythm plugin cannot import host components: its rows carry the host class and ARIA.
    for (const f of ['focus-card.tsx', 'music-card.tsx', 'music-picker.tsx']) {
      expect(read(`plugin-store/walnut-rhythm/src/web/${f}`), f).toMatch(/className="rhythm-option wn-pick-row"/)
    }
    // The shared look: the picked name in --accent-text, never orange.
    const css = read('web/src/styles/pick-and-nav.css')
    expect(css).toMatch(/\.wn-pick-row[^{]*\[aria-selected='true'\][^{]*\{[^}]*color:\s*var\(--accent-text\)/)
    expect(css).not.toMatch(/\.wn-pick-mark/)
    // No colour-only pick of a picker's own left in the composer pickers' stylesheet.
    expect(read('web/src/styles/composer-controls.css')).not.toMatch(/\.picker-row-current/)
    // The menus that drew a check now mark their rows for colour.
    for (const [f, re] of [
      ['web/src/components/common/ContextMenu.tsx', /row\.checked !== undefined \? ' wn-pick-row'/],
      ['web/src/components/tasks/DisplaySections.tsx', /className="dm-view wn-pick-row"/],
      ['web/src/components/board/kanban/KanbanCardMenu.tsx', /className="task-kebab-item wn-pick-row"/],
      ['web/src/components/board/kanban/KanbanLaneMenu.tsx', /' wn-pick-row'/],
      ['web/src/components/tasks/FilterSearchResults.tsx', /fb-hit wn-pick-row/],
      ['web/src/components/tasks/FilterValueList.tsx', /' wn-pick-row'/],
      ['web/src/components/sessions/DraftWhereMenu.tsx', /draft-v6-wm-row wn-pick-row/],
      ['web/src/components/sessions/DraftWhereRow.tsx', /draft-v6-option wn-pick-row/],
      ['web/src/components/sessions/DraftProjectMenu.tsx', /draft-v6-option wn-pick-row/],
    ] as const) expect(read(f), f).toMatch(re)
    // An on/off toggle is a switch.
    expect(read('web/src/components/workspaces/DraftWorkspaceRow.tsx')).toContain('<ToggleSwitch')
  })

  it('no stylesheet shows a check on a selected row', () => {
    // A check that is always in the markup and shown by CSS on the selected state (the draft's
    // mode tiles had one) reads as a pick mark too.
    const found: string[] = []
    for (const dir of [...DIRS, 'web/src/styles']) {
      if (!fs.existsSync(path.join(ROOT, dir))) continue
      for (const file of cssFiles(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, file)
        fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (!SHOWN_CHECK.test(line)) return
          if (ALLOWED_CSS.some((re) => re.test(line))) return
          found.push(`${rel}:${i + 1}: ${line.trim()}`)
        })
      }
    }
    expect(found, 'a selected row is coloured (wn-pick-row), not given a check by its stylesheet').toEqual([])
  })
})
