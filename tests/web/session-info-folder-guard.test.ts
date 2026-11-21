/**
 * Session info must always show the session's working folder, on every surface that
 * has a Session info view: the web session menu (SessionKebabSection, fed by
 * SessionPanel) and the phone's session sheet (SessionInfoSheet).
 * 2026-11-21, the user: "Session info should have right amount of field, like paht
 * where is the fucking path". A surface that drops the folder, or a caller that stops
 * passing it, fails here.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

describe('Session info shows the working folder', () => {
  it('the web menu builds its rows with the folder', () => {
    const section = read('web/src/components/sessions/SessionKebabSection.tsx')
    const calls = section.match(/sessionKebabMetaRows\(\{[^}]*\}/g) ?? []
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(call, call).toMatch(/\bcwd\b/)
    // The rows render inside the Session info group.
    expect(section).toMatch(/label="Session info"[\s\S]*?metaRows\.map/)
  })

  it('every SessionKebabSection gets the session folder', () => {
    const panel = read('web/src/components/sessions/SessionPanel.tsx')
    const uses = panel.match(/<SessionKebabSection[\s\S]*?\/>/g) ?? []
    expect(uses.length).toBeGreaterThan(0)
    for (const use of uses) expect(use).toMatch(/\bcwd=\{session\?\.cwd\}/)
  })

  it('the phone sheet has a Folder row for the session folder', () => {
    const sheet = read('ios-native/Walnut/Views/Tasks/SessionRows.swift')
    const body = sheet.slice(sheet.indexOf('struct SessionInfoSheet'))
    expect(body).toMatch(/if let cwd = session\.cwd[^\n]*\{\s*folderRow\(cwd\)/)
    expect(body).toMatch(/Text\("Folder"\)/)
    // Whole, never cut to a few lines.
    const folderFn = body.slice(body.indexOf('func folderRow'), body.indexOf('func row('))
    expect(folderFn).not.toMatch(/lineLimit/)
  })
})
