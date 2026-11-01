/**
 * Every list of notes search results says WHICH note each row is: its file name
 * and its folder, plus the note's own title when that says something else.
 * A row titled only by a note's first heading hid a file named like
 * `LaunchHook.md` behind an unrelated sentence, so the user could not tell it
 * was the note they meant (2026-11-01).
 *
 * The guard finds every place that asks the notes search for rows (the web
 * client call, the server search function, the HTTP route) by reading the
 * source, and fails on one that neither labels its rows with noteHitLabel nor
 * is listed below as not drawing rows, with why.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { noteHitLabel } from '../../src/core/note-hit-label'
import { fileNameWords } from '../../src/core/notes-index'

const ROOT = path.resolve(__dirname, '../..')

/** Calls that fetch notes search rows. */
const SEARCH_CALL = /\b(searchNotesHybrid|searchNotes|performNotesSearch)\(|['"`]\/api\/(notes-v2|v1\/notes)\/search/

/** Places that ask for notes search rows but draw none themselves. */
const NOT_A_ROW_LIST: Record<string, string> = {
  'web/src/api/notes-v2.ts': 'the client call itself; its callers draw the rows',
  'src/web/routes/notes-v2.ts': 'defines the search; the rows carry path and title for the surfaces to label',
  'src/web/routes/search-memory-v1.ts': 'the /api/v1 edge of the same search; the phone labels its rows (checked below)',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

describe('noteHitLabel', () => {
  it('leads with the file name and keeps a title that says something else', () => {
    expect(noteHitLabel({ path: 'ideas/LaunchHook.md', title: 'How I doubled my output in a week' }))
      .toEqual({ name: 'LaunchHook', folder: 'ideas', title: 'How I doubled my output in a week' })
  })

  it('shows a title that only respells the file name once, as the lead', () => {
    expect(noteHitLabel({ path: 'a/b/launch-hook.md', title: 'Launch hook' })).toEqual({ name: 'Launch hook', folder: 'a/b' })
    expect(noteHitLabel({ path: 'LaunchHook.md', title: 'Launch Hook' })).toEqual({ name: 'Launch Hook', folder: '' })
    expect(noteHitLabel({ path: 'x/plan.md' })).toEqual({ name: 'plan', folder: 'x' })
    expect(noteHitLabel({ path: 'x/plan.md', title: '  ' })).toEqual({ name: 'plan', folder: 'x' })
  })

  it('compares across Unicode forms and never trades a name for punctuation', () => {
    // NFD file name (macOS) vs NFC title, test data: "Cafe\u0301 plan" / "Caf\u00e9 plan".
    expect(noteHitLabel({ path: 'x/Cafe\u0301 plan.md', title: 'Caf\u00e9 plan' })).toEqual({ name: 'Caf\u00e9 plan', folder: 'x' })
    expect(noteHitLabel({ path: 'x/!!.md', title: '??' })).toEqual({ name: '!!', folder: 'x', title: '??' })
  })

  it('keeps an attachment name whole and handles non-Latin names', () => {
    expect(noteHitLabel({ path: 'docs/_attachment/scan.pdf', title: 'scan.pdf' })).toEqual({ name: 'scan.pdf', folder: 'docs/_attachment' })
    // CJK file name and title (test data).
    expect(noteHitLabel({ path: 'journal/\u65e5\u8bb0.md', title: '\u56db\u6708' }))
      .toEqual({ name: '\u65e5\u8bb0', folder: 'journal', title: '\u56db\u6708' })
  })
})

describe('fileNameWords (a file name names its note word by word)', () => {
  it('reads camelCase humps and separators as words, never splitting an acronym', () => {
    expect(fileNameWords('LaunchHook')).toBe('Launch Hook')
    expect(fileNameWords('BudgetListPlan')).toBe('Budget List Plan')
    // A hump after a 1-2 letter start is a name, not two words.
    expect(fileNameWords('ToDoList')).toBe('ToDo List')
    expect(fileNameWords('McLean')).toBe('McLean')
    expect(fileNameWords('iPhoneSetup')).toBe('iPhone Setup')
    expect(fileNameWords('garden-spring_plan')).toBe('garden spring plan')
    expect(fileNameWords('MacOS')).toBe('MacOS')
    expect(fileNameWords('iOS')).toBe('iOS')
    expect(fileNameWords('2026-04-14')).toBe('2026 04 14')
  })
})

describe('every notes search result list labels its rows', () => {
  const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'web/src'))]
  const callers = files
    .filter((f) => SEARCH_CALL.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f).replace(/\\/g, '/'))
    .sort()

  it('finds the known lists (the scan itself works)', () => {
    for (const known of [
      'web/src/components/notes/NotesTreePanel.tsx',
      'web/src/components/notes/CommandPalette.tsx',
      'web/src/components/tasks/PhoneSearchLayer.tsx',
      'src/core/mention-sources/notes-source.ts',
    ]) expect(callers).toContain(known)
  })

  it.each(callers.filter((f) => !(f in NOT_A_ROW_LIST)))('%s uses noteHitLabel', (rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    expect(src, `${rel} lists notes search results: label each row with noteHitLabel (src/core/note-hit-label.ts), or add it to NOT_A_ROW_LIST with why`).toMatch(/\bnoteHitLabel\(/)
  })

  it('lists no stale exemption', () => {
    for (const rel of Object.keys(NOT_A_ROW_LIST)) expect(callers).toContain(rel)
  })

  it('the iPhone app shows each hit’s vault path (file name and folder)', () => {
    const swift = fs.readFileSync(path.join(ROOT, 'ios-native/Walnut/Views/Notes/NoteSearchView.swift'), 'utf8')
    expect(swift).toMatch(/Text\(result\.path/)
  })
})
