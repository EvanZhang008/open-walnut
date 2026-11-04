/**
 * [[wiki links]] in the notes editor: every link is marked as one, an aliased link
 * (`[[folder/Page|Page]]`) hides its `[[target|` and `]]` runs while the selection is elsewhere,
 * and shows its whole source once the selection touches it. A table cell's `\|` alias pipe
 * resolves to the same target.
 */
import { describe, expect, it } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { buildDecorations, hiddenRunAt } from '../../web/src/components/notes/wiki-link/WikiLinkClickExtension'
import { findWikiLinkTrigger } from '../../web/src/components/notes/wiki-link/WikiLinkExtension'

const schema = new Schema({
  nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*' }, text: {} },
})

function docOf(...lines: string[]) {
  return schema.node('doc', null, lines.map((line) => schema.node('paragraph', null, line ? [schema.text(line)] : [])))
}

function spans(doc: ReturnType<typeof docOf>, selection?: { from: number; to: number }) {
  return buildDecorations(doc, selection).find().map((d) => ({
    text: doc.textBetween(d.from, d.to),
    cls: (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs.class,
    target: (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs['data-wikilink-target'],
  }))
}

describe('wiki link display in the notes editor', () => {
  const line = 'See [[Imports/Home/Child A|Child A]] and [[Plain]].'
  // Positions inside the paragraph start at 1.
  const linkFrom = 1 + line.indexOf('[[Imports')
  const linkTo = 1 + line.indexOf(']] and') + 2

  it('shows an aliased link as its alias while the selection is elsewhere', () => {
    const doc = docOf(line, 'other')
    const away = { from: doc.content.size - 1, to: doc.content.size - 1 }
    const all = spans(doc, away)
    expect(all.filter((s) => s.cls === 'notes-wikilink-ref').map((s) => [s.text, s.target])).toEqual([
      ['[[Imports/Home/Child A|Child A]]', 'Imports/Home/Child A'],
      ['[[Plain]]', 'Plain'],
    ])
    expect(all.filter((s) => s.cls === 'notes-wikilink-syntax').map((s) => s.text)).toEqual(['[[Imports/Home/Child A|', ']]'])
  })

  it('shows the whole source once the selection touches the link, at either edge or inside', () => {
    const doc = docOf(line)
    for (const at of [linkFrom, linkFrom + 5, linkTo]) {
      expect(spans(doc, { from: at, to: at }).some((s) => s.cls === 'notes-wikilink-syntax'), `cursor at ${at}`).toBe(false)
    }
    expect(spans(doc, { from: linkTo + 1, to: linkTo + 1 }).filter((s) => s.cls === 'notes-wikilink-syntax')).toHaveLength(2)
  })

  it('reads a table cell\'s escaped alias pipe as the same target', () => {
    const doc = docOf('[[Imports/Home/Notes\\|Notes]]', 'x')
    const ref = spans(doc, { from: doc.content.size - 1, to: doc.content.size - 1 }).find((s) => s.cls === 'notes-wikilink-ref')
    expect(ref?.target).toBe('Imports/Home/Notes')
  })

  // A caret placed in a hidden run from outside (WebKit puts Ctrl+End before the hidden `]]`)
  // goes to that side of the link, so typing never lands inside its source.
  it('finds the hidden runs a caret can land in, and only those', () => {
    const doc = docOf(line)
    const aliasStart = linkTo - 2 - 'Child A'.length
    expect(hiddenRunAt(doc, linkTo - 2)).toMatchObject({ from: linkFrom, to: linkTo })
    expect(hiddenRunAt(doc, linkTo - 1)).toMatchObject({ to: linkTo })
    expect(hiddenRunAt(doc, linkFrom + 3)).toMatchObject({ from: linkFrom })
    for (const at of [linkFrom, aliasStart, aliasStart + 2, linkTo, 1 + line.indexOf('[[Plain') + 3]) expect(hiddenRunAt(doc, at), `at ${at}`).toBeNull()
  })

  it('opens no suggestions for a cursor inside a link that is already closed', () => {
    expect(findWikiLinkTrigger('See [[Imports/Home/Child A|Child A', ']] and [[Plain]].')).toBe(-1)
    expect(findWikiLinkTrigger('See [[Chi', '')).toBe(4)
    // A later link on the line is not this one's end.
    expect(findWikiLinkTrigger('See [[Chi', ' and [[Plain]]')).toBe(4)
  })

  it('draws a link to a note that is not there as missing, and leaves it alone while that is unknown', () => {
    const doc = docOf('[[Imports/Home|Home]] and [[Imports/Gone|Gone]] and [[Elsewhere]]')
    const missing = (t: string) => t === 'Imports/Gone' ? true : t === 'Elsewhere' ? null : false
    const refs = buildDecorations(doc, undefined, missing).find()
      .map((d) => (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs)
      .filter((a) => a['data-wikilink-target'])
    expect(refs.map((a) => [a['data-wikilink-target'], a.class])).toEqual([
      ['Imports/Home', 'notes-wikilink-ref'],
      ['Imports/Gone', 'notes-wikilink-ref notes-wikilink-missing'],
      ['Elsewhere', 'notes-wikilink-ref'],
    ])
  })
})
