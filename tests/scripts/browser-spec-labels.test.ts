/**
 * Browser specs find the controls they press by words the UI still has.
 *
 * 2026-11-26, CI 45816478315: 35d5a42e9b ("Page heads") put create labels in sentence case and made
 * Mail's New message key a `.btn.btn-primary`, and updated the specs that named them, but missed two.
 * first-use-files still asked for the menu item "New File…", which no longer existed, so its click
 * waited until the 90 s test timeout; mail-app-unified clicked the first page-wide `.btn.btn-primary`
 * as a "confirm", which was now New message, so the composer opened again and never left.
 *
 * - Every quoted menu item name a spec asks for is a whole string or JSX text in web/src (a name
 *   built at run time is listed below with where it comes from).
 * - No spec finds a control page-wide by a button style class: a style class names a look, which
 *   any new key can share, never one control.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const BROWSER = path.join(ROOT, 'tests/e2e/browser')

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)])
}

// Names the UI builds at run time, so no source holds them whole.
const BUILT_NAMES: Record<string, string> = {
  'Collapse Satellite': 'Collapse <tier label> (web/src/components/tasks/TodoPanel.tsx), for the Satellite tier',
  'Open in Team Chat': 'Open in <link handler title> (web/src/plugins/LinkCaptureHost.tsx), the handler link-capture.spec.ts installs',
}

// `getByRole('menuitem', { name: ... })`: the name expression, up to the object's end.
const MENUITEM = /getByRole\(\s*['"]menuitem['"]\s*,\s*\{\s*name:\s*([^}]*)\}/g
// Quoted strings in it, never a template with a placeholder.
const QUOTED = /'((?:[^'\\\n]|\\.)+)'|"((?:[^"\\\n]|\\.)+)"|`([^`$\n]+)`/g

// A `\u2026` in either source reads as the character it names.
const decodeU = (s: string): string => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
const unescape = (s: string): string => decodeU(s).replace(/\\(.)/g, '$1')

// A line that checks a name is gone (`toHaveCount(0)`) asks for no control, so it is left out.
export function menuItemNames(text: string): string[] {
  return text.split('\n').filter((line) => !line.includes('toHaveCount(0)')).flatMap((line) => [...line.matchAll(MENUITEM)]).flatMap((m) => [...m[1].matchAll(QUOTED)].map((q) => unescape(q[1] ?? q[2] ?? q[3])))
}

// The name as the UI writes it: a whole quoted string or a whole JSX text, never inside a comment.
export function inUi(web: string, name: string): boolean {
  return [`'${name}'`, `"${name}"`, `\`${name}\``, `>${name}<`].some((form) => web.includes(form))
    || new RegExp(`>\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*<`).test(web)
}

// `page.locator('.btn.btn-primary')`, `page.locator(".btn-danger")`: a page-wide find by a button look.
export const STYLE_CLASS_FIND = /\bpage\.locator\(\s*['"`]\.btn(?:[.-][\w-]+)*['"`]\s*\)/

describe('browser specs name controls the UI still has', () => {
  const specs = walk(BROWSER).filter((f) => f.endsWith('.ts')).map((f) => ({ file: path.relative(BROWSER, f), text: fs.readFileSync(f, 'utf8') }))
  const web = walk(path.join(ROOT, 'web/src')).filter((f) => /\.(tsx?|json)$/.test(f)).map((f) => decodeU(fs.readFileSync(f, 'utf8')).replaceAll('&amp;', '&')).join('\n')

  it('every quoted menu item name a spec asks for is in web/src', () => {
    const names = specs.flatMap(({ file, text }) => menuItemNames(text).map((name) => ({ file, name })))
    expect(names.length, 'the scan finds the menu item names').toBeGreaterThan(100)
    const missing = names.filter(({ name }) => !(name in BUILT_NAMES) && !inUi(web, name)).map(({ file, name }) => `${file}: ${name}`)
    expect(missing, 'the UI no longer has this menu item name: ask for the words it shows now').toEqual([])
  })

  it('no spec finds a control page-wide by a button style class', () => {
    const found = specs.flatMap(({ file, text }) => text.split('\n').flatMap((line, i) => (STYLE_CLASS_FIND.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])))
    expect(found, 'find the control by its role and name, or by its test id').toEqual([])
  })

  it('reads every quoted name, a choice included, and leaves a template alone', () => {
    expect(menuItemNames(`page.getByRole('menuitem', { name: 'New folder…' }).click()`)).toEqual(['New folder…'])
    expect(menuItemNames(`menu.getByRole("menuitem", { name: kind === 'File' ? 'New file…' : 'New folder…', exact: true })`))
      .toEqual(['File', 'New file…', 'New folder…'])
    expect(menuItemNames('page.getByRole(\'menuitem\', { name: `New ${kind}…` })')).toEqual([])
    expect(menuItemNames(`page.getByRole('menuitem', { name: /^Open/ })`)).toEqual([])
    expect(menuItemNames(`await expect(menu.getByRole('menuitem', { name: 'Make a task' })).toHaveCount(0)`)).toEqual([])
    expect(menuItemNames(`page.getByRole('menuitem', { name: 'New project\\u2026' })`)).toEqual(['New project\u2026'])
  })

  it('finds a name only as the UI writes it, never in a comment', () => {
    expect(inUi(`label: 'New file…',`, 'New file…')).toBe(true)
    expect(inUi(`<li>\n  New file…\n</li>`, 'New file…')).toBe(true)
    expect(inUi(`// what makes "New File… at the cwd" reachable`, 'New File…')).toBe(false)
  })

  it('catches a page-wide find by a button look, and leaves a scoped or named find alone', () => {
    expect(STYLE_CLASS_FIND.test(`const confirm = page.locator('.btn.btn-primary')`)).toBe(true)
    expect(STYLE_CLASS_FIND.test(`await page.locator(".btn-danger").click()`)).toBe(true)
    expect(STYLE_CLASS_FIND.test(`await dialog.locator('.btn.btn-primary').click()`)).toBe(false)
    expect(STYLE_CLASS_FIND.test(`await page.getByRole('button', { name: 'Discard' }).click()`)).toBe(false)
  })
})
