/**
 * A browser spec that works on the Notes page finds the note's editor inside the page's own
 * pane (`.notes-editor-pane`), never by an editor class alone.
 *
 * The class: Home (MainPage) stays mounted, hidden, on every route (web/src/App.tsx), and its
 * Scratchpad keeps its pane mounted once it has been shown (HomeCompanionPanel.tsx). The
 * Scratchpad is the same NotesEditor, so `.notes-editor`, `.notes-editor-content`, `.tiptap` and
 * `.ProseMirror` all match it too, and it comes first in the DOM. Whether it is open is a synced
 * ui-pref, shared by every browser of the one fixture server. On 2026-11-07 the notes stress
 * spec (it types into the Scratchpad) ran beside the notes image specs on CI shard 7: their
 * `page.locator('.notes-editor .tiptap').first()` read the hidden Scratchpad ("0") instead of
 * the note ("Image forms"), and all three image tests failed, retries included. Alone, with the
 * Scratchpad closed, they passed.
 *
 * What fails here: in a spec or helper that goes to the Notes page, a `page.locator(...)`,
 * `page.$(...)`, `page.$$(...)` or `document.querySelector(All)(...)` whose selector starts with
 * one of those shared editor classes.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SPECS = path.join(__dirname, '../e2e/browser')
const NOTES_PAGE = path.join(__dirname, '../../web/src/pages/NotesPage.tsx')

/** A file that navigates to the Notes page. */
const REACHES_NOTES = /href="\/notes"|goto\(\s*['"`]\/notes\b/

/** A page-wide lookup whose selector starts with an editor class the Scratchpad shares. */
const UNSCOPED = /\b(?:page\.(?:locator|\$\$?)|document\.querySelector(?:All)?)\(\s*['"`](?:\.notes-editor(?![\w-])|\.notes-editor-content\b|\.tiptap\b|\.ProseMirror\b)/

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsFiles(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('Notes page specs scope the editor to the page pane', () => {
  it('the matcher flags a page-wide editor lookup and passes a scoped one', () => {
    expect(UNSCOPED.test(`page.locator('.notes-editor .tiptap').first()`)).toBe(true)
    expect(UNSCOPED.test(`page.locator('.notes-editor-content').first()`)).toBe(true)
    expect(UNSCOPED.test(`page.locator('.ProseMirror').first()`)).toBe(true)
    expect(UNSCOPED.test(`document.querySelector('.tiptap')?.dispatchEvent(e)`)).toBe(true)
    expect(UNSCOPED.test(`page.locator('.notes-editor-pane .notes-editor .tiptap').first()`)).toBe(false)
    expect(UNSCOPED.test(`pane.locator('.notes-editor .tiptap')`)).toBe(false)
    expect(UNSCOPED.test(`page.locator('.notes-editor-pane .ProseMirror')`)).toBe(false)
  })

  it('the Notes page still draws its editor inside .notes-editor-pane', () => {
    expect(fs.readFileSync(NOTES_PAGE, 'utf8')).toContain('className="notes-editor-pane"')
  })

  it('no spec on the Notes page finds the editor by an editor class alone', () => {
    const offenders: string[] = []
    for (const file of tsFiles(SPECS)) {
      const text = fs.readFileSync(file, 'utf8')
      if (!REACHES_NOTES.test(text)) continue
      text.split('\n').forEach((line, i) => {
        if (UNSCOPED.test(line)) offenders.push(`${path.relative(SPECS, file)}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders, `Scope these to '.notes-editor-pane ...' (the hidden Home Scratchpad matches them first):\n${offenders.join('\n')}`).toEqual([])
  })
})
