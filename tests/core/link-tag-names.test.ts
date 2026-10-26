import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LINK_PATTERNS, linkEntriesFromField, linkKindGroup, linkTagName, linkTagNames, mergeLinkNames, normalizeLinkName,
} from '../../src/core/link-tags.js'

// The names link pills read (link-tags.ts). The task detail serves them (`links`, linkTagViews),
// so the phone reads these same names.
const NAMES: [string, string][] = [
  ['plan:/tmp/rich-live/fix/MATRIX-r5.md', 'Matrix r5'],
  ['plan:/tmp/rich-live/fix/FIX-PLAN-r5b.md', 'Fix plan r5b'],
  ['report:/tmp/alpha/result.html', 'Alpha result'],
  ['notes:/Users/me/repo/CLAUDE.md', 'Repo CLAUDE.md'],
  ['resume:/Users/me/Claude-Resume-2026-10.pdf', 'Claude resume 2026'],
  ['notes:/Users/me/linkTagsDesignNotes.md', 'Link tags design'],
  ['plan:/tmp/iOS_api-plan.md', 'iOS API plan'],
  ['pr:https://github.com/acme/app/pull/12', 'app#12'],
  ['ticket:https://acme.atlassian.net/browse/ENG-42', 'ENG-42'],
  ['thread:https://acme.slack.com/archives/C01/p1726', 'Acme thread'],
  ['design-doc:https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWx12345/edit', 'Google design doc'],
  ['link:https://example.com/blog/how-we-ship-fast', 'How we ship'],
]

describe('linkTagName', () => {
  it.each(NAMES)('%s reads %s', (tag, name) => {
    expect(linkTagName(tag)).toBe(name)
  })

  it('reads the name a session gave, except for a kind told apart by its id', () => {
    expect(linkTagName('plan:/tmp/x/MATRIX-r5.md', { '/tmp/x/MATRIX-r5.md': 'Test matrix r5' })).toBe('Test matrix r5')
    expect(linkTagName('pr:https://github.com/acme/app/pull/12', { 'https://github.com/acme/app/pull/12': 'Retry fix' })).toBe('app#12')
  })

  it('is undefined for a tag that is not a link', () => {
    expect(linkTagName('sev:2')).toBeUndefined()
  })
})

describe('linkTagNames', () => {
  const names = (tags: string[], given?: Record<string, string>) => [...linkTagNames(tags, given).values()]

  it('tells apart the three plans the user saw as "plan +2"', () => {
    expect(names([
      'plan:/tmp/rich-live/fix/MATRIX-r5.md', 'plan:/tmp/rich-live/fix/FIX-PLAN-r5b.md', 'plan:/tmp/rich-live/fix/FIX-PLAN-r5c.md',
    ])).toEqual(['Matrix r5', 'Fix plan r5b', 'Fix plan r5c'])
  })

  it('adds the word that differs when the first three are the same', () => {
    expect(names(['design-doc:/x/session-link-tags-design-v1.md', 'design-doc:/x/session-link-tags-design-v2.md']))
      .toEqual(['Session link v1', 'Session link v2'])
  })

  it('adds the folder when the file names are the same, then a number', () => {
    expect(names(['report:/tmp/a/index.html', 'report:/tmp/b/index.html', 'report:/tmp/b/index.htm']))
      .toEqual(['A index', 'B index', 'B index 2'])
  })

  it('never repeats a name, whatever the session gave', () => {
    const out = names(['plan:/a/x.md', 'plan:/b/y.md'], { '/a/x.md': 'Rollout', '/b/y.md': 'Rollout' })
    expect(new Set(out.map((n) => n.toLowerCase())).size).toBe(2)
  })

  it('never repeats a name across groups either', () => {
    for (const tags of [
      ['plan:/a/r/foo.md', 'plan:/b/r/foo.md', 'plan:/c/foo-2.md'],
      ['plan:/r/foo.md', 'plan:/s/foo.md', 'plan:/q/r-foo.md'],
    ]) {
      const out = names(tags)
      expect(new Set(out.map((n) => n.toLowerCase())).size).toBe(tags.length)
    }
  })

  it('leaves tags that are not links out', () => {
    expect([...linkTagNames(['sev:2', 'plan:/a/x.md']).keys()]).toEqual(['plan:/a/x.md'])
  })
})

describe('normalizeLinkName', () => {
  it('keeps at most three words and no markup', () => {
    expect(normalizeLinkName('  **Run 42 results summary page** ')).toBe('Run 42 results')
    expect(normalizeLinkName('— Fix plan r5b.')).toBe('Fix plan r5b')
  })
  it('refuses a path, a URL or nothing readable', () => {
    expect(normalizeLinkName('/tmp/x.md')).toBeUndefined()
    expect(normalizeLinkName('https://x.dev')).toBeUndefined()
    expect(normalizeLinkName(' -- ')).toBeUndefined()
  })
  it('never cuts an emoji in half', () => {
    const name = normalizeLinkName('Abcdefghijklmnopqrstuvwxyz\u{1F680}\u{1F680}\u{1F680}')!
    expect(name.endsWith('\u2026')).toBe(true)
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(name)).toBe(false)
  })
  it('caps a long name with an ellipsis', () => {
    expect(normalizeLinkName('Supercalifragilistic expialidocious documentation')!.length).toBeLessThanOrEqual(28)
  })
  it('keeps letters of any script', () => {
    expect(normalizeLinkName('\u6d4b\u8bd5\u77e9\u9635 r5')).toBe('\u6d4b\u8bd5\u77e9\u9635 r5')
  })
})

describe('linkEntriesFromField', () => {
  it('reads the name after the target, for a path and a URL', () => {
    const field = [
      '- plan: /tmp/rich-live/fix/FIX-PLAN-r5b.md (Fix plan r5b)',
      '- report: `/tmp/run/result.html` - Run 42 results summary page',
      '- pr: https://github.com/acme/app/pull/12 (Retry fix)',
      '- issue: https://github.com/acme/app/issues/9',
      '- [design](https://example.com/d/xyz) (Sync design)',
      '- plan (v2): /tmp/x/rollout.md',
    ].join('\n')
    expect(linkEntriesFromField(field, DEFAULT_LINK_PATTERNS)).toEqual([
      { tag: 'plan:/tmp/rich-live/fix/FIX-PLAN-r5b.md', name: 'Fix plan r5b' },
      { tag: 'report:/tmp/run/result.html', name: 'Run 42 results' },
      { tag: 'pr:https://github.com/acme/app/pull/12', name: 'Retry fix' },
      { tag: 'issue:https://github.com/acme/app/issues/9' },
      { tag: 'design:https://example.com/d/xyz', name: 'Sync design' },
      { tag: 'plan:/tmp/x/rollout.md' },
    ])
  })
})

describe('mergeLinkNames', () => {
  const task = { tags: ['plan:/a/x.md', 'plan:/b/y.md'], link_names: { '/a/x.md': 'First name' } }

  it('names a held link that has no name yet, and keeps a name once given', () => {
    expect(mergeLinkNames(task, { '/a/x.md': 'Second name', '/b/y.md': 'Rollout plan' }))
      .toEqual({ '/a/x.md': 'First name', '/b/y.md': 'Rollout plan' })
  })
  it('ignores a link the task does not hold, and drops names of links it lost', () => {
    expect(mergeLinkNames(task, { '/c/z.md': 'Elsewhere' })).toBeUndefined()
    expect(mergeLinkNames({ tags: ['plan:/b/y.md'], link_names: { '/a/x.md': 'Gone' } }, {})).toEqual({})
  })
})

describe('linkKindGroup', () => {
  it('maps kinds to the icon a pill shows', () => {
    expect(['plan', 'design-doc', 'report', 'notes', 'resume'].map(linkKindGroup)).toEqual(['doc', 'doc', 'doc', 'doc', 'doc'])
    expect(['pr', 'mr', 'cr'].map(linkKindGroup)).toEqual(['review', 'review', 'review'])
    expect(['ticket', 'issue', 'incident'].map(linkKindGroup)).toEqual(['ticket', 'ticket', 'ticket'])
    expect(linkKindGroup('thread')).toBe('thread')
    expect(linkKindGroup('link')).toBe('link')
  })
})
