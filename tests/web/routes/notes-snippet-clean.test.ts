/**
 * Search snippets read as prose: a link reads as its alias, a window cut through a link keeps
 * only its words, and callout and quote markers are gone (imported notes are full of all three).
 */
import { describe, expect, it } from 'vitest'
import { makeSnippet } from '../../../src/web/routes/notes-v2.js'

const plain = (s: string) => s.replace(/<\/?mark>/g, '')

describe('notes search snippet', () => {
  it('reads a link by its alias, also inside a table', () => {
    const clean = (body: string, q: string) => { const out = plain(makeSnippet(body, q)); expect(out).not.toMatch(/\[\[|\]\]|\||Import from Notion/); return out }
    expect(clean('See [[Import from Notion/Home/Child A/Child A|Child A]] for more', 'more')).toMatch(/Child A for more$/)
    expect(clean('| [[Import from Notion/Home/Tasks/Plan trip\\|Plan trip]] | Todo |', 'todo')).toMatch(/Plan trip Todo$/)
    expect(clean('Go to [[Projects/Roadmap]] now', 'now')).toMatch(/Roadmap now$/)
  })

  it('a window that starts inside a link keeps only its words', () => {
    const body = `${'word '.repeat(80)}[[Import from Notion/Home/Child A/Child A|Child A]] has the needle here`
    const s = plain(makeSnippet(body, 'needle'))
    expect(s).toContain('needle')
    expect(s).not.toMatch(/\]\]|\[\[|\|/)
  })

  it('drops callout and quote markers', () => {
    const s = plain(makeSnippet('> [!note]- Details\n> Hidden text\n> [!warning] Careful', 'hidden'))
    expect(s).not.toMatch(/\[!|&gt;|>/)
    expect(s).toContain('Hidden text')
  })
})
