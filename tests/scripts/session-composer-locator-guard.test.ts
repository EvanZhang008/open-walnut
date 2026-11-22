/**
 * No browser spec finds a session's composer by its placeholder: the placeholder says the
 * session's state and changes under the spec ("New reply above, not read yet. ..." while a reply
 * is unread, 3437e252c4). Nightly 45035328727 lost agent-text-paths.spec.ts that way: the agent's
 * reply arrived, the placeholder changed, and the press found no box. Specs use
 * sessionComposer() from tests/e2e/browser/session-composer.ts, which finds the box by its place.
 *
 * The placeholder words are read from SessionPanel.tsx itself, so a new wording is covered the
 * day it ships.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const DIR = path.join(ROOT, 'tests/e2e/browser')
const PANEL = path.join(ROOT, 'web/src/components/sessions/SessionPanel.tsx')

/** Every string the session composer's placeholder expression can say. */
function composerPlaceholders(): string[] {
  const lines = fs.readFileSync(PANEL, 'utf8').split('\n')
  const start = lines.findIndex((l) => /^\s*placeholder=\{plainChat \?/.test(l))
  expect(start, 'SessionPanel.tsx still sets the composer placeholder in one expression').toBeGreaterThan(-1)
  const end = lines.findIndex((l, i) => i > start && /^\s*onValueChange=/.test(l))
  expect(end, 'the placeholder expression ends before onValueChange').toBeGreaterThan(start)
  return [...lines.slice(start, end).join('\n').matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/** The words a locator would need to match a placeholder; short ones ("Message") name too much to flag. */
function stems(placeholders: string[]): string[] {
  return placeholders.map((p) => p.replace(/(\.\.\.|…).*$/, '').trim()).filter((s) => s.length >= 12)
}

// A locator that matches by placeholder or accessible name (a textarea's name is its placeholder).
const LOCATOR = /getByPlaceholder\(|getByLabel\(|getByRole\(\s*['"`]textbox['"`]|placeholder[*^$~|]?=/

function offenders(file: string, text: string, words: string[]): string[] {
  return text.split('\n').flatMap((line, i) =>
    LOCATOR.test(line) && words.some((w) => line.includes(w)) ? [`${file}:${i + 1}: ${line.trim()}`] : [])
}

describe('session composer locators', () => {
  const words = stems(composerPlaceholders())

  it('reads the placeholder words from the panel', () => {
    // Since 6f4a477964 (2026-11-23) a desktop box is empty but for an unread reply's words; its name
    // ("Send a message to this session") moved to aria-label, which does not change under a spec.
    expect(words).toEqual(expect.arrayContaining(['New reply above, not read yet']))
  })

  it('no browser spec finds the session composer by its placeholder', () => {
    // Subfolders too (fixtures, helpers): a locator there reaches the specs that import it.
    const found = (fs.readdirSync(DIR, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'))
      .flatMap((f) => offenders(f, fs.readFileSync(path.join(DIR, f), 'utf8'), words))
    expect(found, 'use sessionComposer() from tests/e2e/browser/session-composer.ts').toEqual([])
  })

  it('catches every locator form and leaves an assertion on the placeholder alone', () => {
    const flag = (line: string) => offenders('x.spec.ts', line, words).length > 0
    expect(flag(`page.getByPlaceholder('New reply above, not read yet')`)).toBe(true)
    expect(flag(`page.locator('textarea[placeholder*="New reply above, not read yet"]')`)).toBe(true)
    expect(flag(`page.getByRole('textbox', { name: /^New reply above, not read yet/ })`)).toBe(true)
    expect(flag(`panel.getByPlaceholder(/New reply above, not read yet/)`)).toBe(true)
    expect(flag(`await expect(box).toHaveAttribute('placeholder', /New reply above, not read yet/)`)).toBe(false)
    expect(flag(`const input = sessionComposer(page).first()`)).toBe(false)
  })
})
