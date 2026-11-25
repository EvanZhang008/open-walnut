/**
 * Every row of a nav list is the shared Nav item (`.wn-nav-item`, web/src/styles/pick-and-nav.css):
 * one height, padding, gap and type for the sidebar, the Settings nav and the notification rail.
 * A row class of one of those lists without it drew its own: on 2026-11-24 the expanded sidebar's
 * bottom rows (a status ring, Quick bar, Notifications) were 22 to 24 px tall with the icon against
 * the words, and the bell's row sat 65 px to the right of the others.
 * A new className string that names a nav row class must name `wn-nav-item` too.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const WEB_SRC = join(ROOT, 'web', 'src')

/** The row class of each nav list whose rows are Nav items. */
export const NAV_ROW_CLASSES = ['sidebar-link', 'settings-nav-item', 'nfc-rail-btn'] as const

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p))
    else if (name.endsWith('.tsx')) out.push(p)
  }
  return out
}

/** Class lists in string and template literals that name a nav row class but not wn-nav-item. */
export function rowsWithoutNavItem(source: string): string[] {
  const out: string[] = []
  for (const m of source.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
    const words = m[2].split(/[\s{}$]+/)
    if (!NAV_ROW_CLASSES.some((c) => words.includes(c))) continue
    if (words.includes('wn-nav-item')) continue
    out.push(m[2])
  }
  return out
}

describe('nav list rows are the shared Nav item', () => {
  it('finds a row class without wn-nav-item and passes one with it', () => {
    expect(rowsWithoutNavItem('<button className="sidebar-link sidebar-quickbar-link" />')).toEqual(['sidebar-link sidebar-quickbar-link'])
    expect(rowsWithoutNavItem('<b className={`sidebar-link x${a ? " on" : ""}`} />')).toHaveLength(1)
    expect(rowsWithoutNavItem('<button className="sidebar-link wn-nav-item sidebar-quickbar-link" />')).toEqual([])
    expect(rowsWithoutNavItem("el.closest('.sidebar-link-icon')")).toEqual([])
  })

  it('every nav row class in web/src carries wn-nav-item', () => {
    const hits: string[] = []
    for (const f of tsxFiles(WEB_SRC)) {
      for (const h of rowsWithoutNavItem(readFileSync(f, 'utf8'))) hits.push(`${relative(ROOT, f)}: "${h}"`)
    }
    expect(hits).toEqual([])
  })
})
