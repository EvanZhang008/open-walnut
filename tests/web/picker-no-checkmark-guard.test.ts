/**
 * A picker shows its current item by colour, never by a checkmark (2026-11-14, the user:
 * "why must there be a checkmark ... just show the name, and colour the selected one").
 * This reads every web component and fails when one draws a checkmark beside a selectable
 * row again: a glyph switched on a condition, a lone glyph in a span, or an element whose
 * class ends in "-check". The current choice is a colour; an on/off toggle is a switch. A
 * real checkbox, and a mark that says a step is done, are listed below with why.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../..')
const DIRS = ['web/src/components', 'web/src/apps', 'web/src/pages']
/** Not a picker's current choice: each line says what it is. */
const ALLOWED: Record<string, RegExp[]> = {
  // A multi-select checkbox on a task card (role="checkbox"), as in the main task list.
  'web/src/components/tasks/FocusSatelliteCards.tsx': [/isSelected \? '✓' : ''/],
  // "Unsubscribed" done mark on a mail line: a finished step, nothing to choose.
  'web/src/apps/mail/MailReaderHead.tsx': [/mail-reader-unsub-check/],
  // The "permission granted" badge of the fix dialog: a finished step.
  'web/src/components/common/PermissionFixDialog.tsx': [/permission-granted-check/],
}

const SELECTION_MARK = [
  /\?\s*['"`][✓✔]['"`]\s*:\s*(['"`]{2}|null|undefined)/, // {on ? '✓' : ''}
  /&&\s*(<span[^>]*>)?\s*['"`]?[✓✔]/, // {on && <span>✓</span>}
  /<span className="[^"]*-check"[^>]*>\s*[✓✔]\s*</, // <span className="x-check">✓</span>
  /<span className="[^"]*-check"\s*\/>/, // the empty column kept for one
]

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    return e.isDirectory() ? files(full) : /\.tsx$/.test(e.name) ? [full] : []
  })
}

describe('pickers show the current item by colour', () => {
  it('no component draws a selection checkmark', () => {
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
    expect(found, 'show the selected row with .picker-row-current (colour), not a checkmark').toEqual([])
  })

  it('the pickers that had one keep their rows marked for colour and for assistive tech', () => {
    const read = (f: string) => fs.readFileSync(path.join(ROOT, 'web/src/components/sessions', f), 'utf8')
    expect(read('ModelPicker.tsx')).toContain('picker-row-current')
    expect(read('PermissionModeMenu.tsx')).toContain('picker-row-current')
    for (const f of ['ModelPicker.tsx', 'PermissionModeMenu.tsx', 'SessionControlPills.tsx', 'DiffComparePicker.tsx']) {
      expect(read(f), f).toMatch(/aria-selected/)
    }
    const css = fs.readFileSync(path.join(ROOT, 'web/src/styles/composer-controls.css'), 'utf8')
    // An on/off toggle is a switch.
    const ws = fs.readFileSync(path.join(ROOT, 'web/src/components/workspaces/DraftWorkspaceRow.tsx'), 'utf8')
    expect(ws).toContain('draft-workspace-switch')
    expect(css).toMatch(/\.picker-row-current[^{]*\{[^}]*var\(--accent\)/)
  })
})
