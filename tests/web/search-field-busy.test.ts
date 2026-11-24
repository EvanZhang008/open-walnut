/**
 * A search still running draws its busy ring in the field's leading icon slot, never as a key beside
 * the words (2026-11-24: in a 25% Home task panel the ring beside the keys left the typed words 50 px
 * while the search ran and 74 px once it ended; todo-search-and-filters.spec.ts measures both).
 * SSR through renderToStaticMarkup, as choice-controls-markup.test.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createElement as h } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import { SearchField } from '../../web/src/components/common/SearchField'

const { MemoryRouter } = await import('../../web/node_modules/react-router-dom')

const noop = () => {}
// The field's mic reads the router (its voice settings link), as it does on every page.
const html = (busy: boolean) => renderToStaticMarkup(h(MemoryRouter, null, h(SearchField, {
  value: 'marmalade', onChange: noop, onClear: noop, busy, busyClassName: 'todo-search-spinner', small: true,
})) as never)

describe('SearchField: the busy ring takes no room of its own', () => {
  it('while busy the ring is inside the icon slot, in place of the magnifier', () => {
    const out = html(true)
    expect(out).toMatch(/<span class="wn-field-icon"[^>]*><span class="wn-field-busy todo-search-spinner"><\/span><\/span>/)
    expect((out.match(/wn-field-busy/g) ?? []).length).toBe(1)
    expect(out).not.toMatch(/<span class="wn-field-icon"[^>]*><svg/)
  })

  it('busy or not, the field holds the same slots after its words', () => {
    const after = (out: string) => out.slice(out.indexOf('<input')).replace(/<svg[\s\S]*?<\/svg>/g, '')
    expect(after(html(true))).toBe(after(html(false)))
    expect(html(false)).toMatch(/<span class="wn-field-icon"[^>]*><svg/)
  })

  it('no other file draws a busy ring of the field look', () => {
    const root = path.resolve(import.meta.dirname, '../../web/src')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name) && !p.endsWith(path.join('common', 'SearchField.tsx')) && fs.readFileSync(p, 'utf-8').includes('wn-field-busy')) offenders.push(path.relative(root, p))
      }
    }
    walk(root)
    expect(offenders, 'draw a running search with SearchField busy, which keeps the words their width').toEqual([])
  })
})
