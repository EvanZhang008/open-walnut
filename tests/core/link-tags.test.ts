/**
 * Link tags as pure logic (src/core/link-tags.ts): which URLs the patterns recognise in text,
 * the canonical form two mentions of one link share, the short label a pill reads, the
 * self-report LINKS field, which candidates a task still lacks, and how the tag model and the
 * display rules treat a tag whose value is a URL.
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_LINK_PATTERNS,
  MAX_LINK_TAGS,
  canonicalLinkUrl,
  effectiveLinkPatterns,
  linkLabel,
  linkTagsFromField,
  linkTagsInText,
  linkUrlOfTag,
  linkPathOfTag,
  linkTagLabel,
  canonicalLinkPath,
  newLinkTags,
} from '../../src/core/link-tags.js'
import { isNormalTag, normalizeTag, tagInputProblem } from '../../src/core/tag-model.js'
import { compileTagDisplay } from '../../src/core/tag-display-rules.js'
import { extractField, buildSelfReportPrompt } from '../../src/core/session-hooks/builtins.js'

const CR = String.raw`https://reviews\.example\.com/r/RV-\d+`

describe('linkTagsInText', () => {
  it('finds GitHub, GitLab, Jira and Linear links in prose, first mention first', () => {
    const text = [
      'Fix https://github.com/acme/app/issues/42 then see',
      '(https://github.com/acme/app/pull/77/files) and https://gitlab.com/g/sub/proj/-/merge_requests/5.',
      'Tracked in https://acme.atlassian.net/browse/ENG-12 and https://linear.app/acme/issue/OPS-9/some-slug',
      'thread https://acme.slack.com/archives/C0123ABC/p1726000000123456?thread_ts=1726000000.123456',
    ].join('\n')
    expect(linkTagsInText(text, DEFAULT_LINK_PATTERNS)).toEqual([
      'issue:https://github.com/acme/app/issues/42',
      'pr:https://github.com/acme/app/pull/77',
      'mr:https://gitlab.com/g/sub/proj/-/merge_requests/5',
      'ticket:https://acme.atlassian.net/browse/ENG-12',
      'ticket:https://linear.app/acme/issue/OPS-9',
      'thread:https://acme.slack.com/archives/C0123ABC/p1726000000123456',
    ])
  })

  it('tags one link once however often and however decorated it is mentioned', () => {
    const text = 'https://github.com/acme/app/pull/7, again <https://github.com/acme/app/pull/7>, **https://github.com/acme/app/pull/7**'
    expect(linkTagsInText(text, DEFAULT_LINK_PATTERNS)).toEqual(['pr:https://github.com/acme/app/pull/7'])
  })

  it('ignores URLs no pattern knows and text without links', () => {
    expect(linkTagsInText('read https://example.com/blog/post and https://github.com/acme/app', DEFAULT_LINK_PATTERNS)).toEqual([])
    expect(linkTagsInText('', DEFAULT_LINK_PATTERNS)).toEqual([])
    expect(linkTagsInText('修复这个 bug', DEFAULT_LINK_PATTERNS)).toEqual([])
  })

  it('reads a user pattern, and a user key replaces Walnut\'s for that key', () => {
    const patterns = effectiveLinkPatterns({ cr: CR, pr: '' })
    expect(linkTagsInText('see https://reviews.example.com/r/RV-4242 and https://github.com/a/b/pull/1', patterns))
      .toEqual(['cr:https://reviews.example.com/r/RV-4242'])
  })

  it('skips a broken user regex and a key that is not a tag key', () => {
    const patterns = effectiveLinkPatterns({ cr: '(', 'Bad Key': CR })
    expect(patterns.some((p) => p.key === 'cr')).toBe(true)
    expect(patterns.some((p) => p.key === 'bad key')).toBe(false)
    expect(linkTagsInText('https://github.com/a/b/issues/3', patterns)).toEqual(['issue:https://github.com/a/b/issues/3'])
  })

  it('never stalls on a huge paste', () => {
    const text = `${'x '.repeat(400_000)} https://github.com/a/b/pull/1`
    const at = performance.now()
    expect(linkTagsInText(text, DEFAULT_LINK_PATTERNS)).toEqual([])
    expect(performance.now() - at).toBeLessThan(1000)
  })
})

describe('canonicalLinkUrl', () => {
  it('drops a fragment, trailing slashes and sentence punctuation, and lowercases the host', () => {
    expect(canonicalLinkUrl('https://GitHub.com/acme/app/pull/7/#discussion')).toBe('https://github.com/acme/app/pull/7')
    expect(canonicalLinkUrl('https://x.example.com/a/b).')).toBe('https://x.example.com/a/b')
    expect(canonicalLinkUrl('https://x.example.com/a?q=1#top')).toBe('https://x.example.com/a?q=1')
  })

  it('refuses what is not an http(s) URL short enough to be a tag', () => {
    expect(canonicalLinkUrl('ftp://x.example.com/a')).toBeUndefined()
    expect(canonicalLinkUrl('not a url')).toBeUndefined()
    expect(canonicalLinkUrl(`https://x.example.com/${'a'.repeat(300)}`)).toBeUndefined()
  })
})

describe('linkLabel', () => {
  it('reads a forge link as repo#n, a tracker link as its id, else a short segment or host', () => {
    expect(linkLabel('https://github.com/acme/app/pull/77')).toBe('app#77')
    expect(linkLabel('https://github.com/acme/app/issues/42')).toBe('app#42')
    expect(linkLabel('https://gitlab.com/g/sub/proj/-/merge_requests/5')).toBe('proj#5')
    expect(linkLabel('https://acme.atlassian.net/browse/ENG-12')).toBe('ENG-12')
    expect(linkLabel('https://reviews.example.com/r/RV-4242')).toBe('RV-4242')
    expect(linkLabel('https://tickets.example.com/V1234567890')).toBe('V1234567890')
    expect(linkLabel('https://docs.example.com/')).toBe('docs.example.com')
    // An opaque id reads as its head, never a 24-character run of hex.
    expect(linkLabel('https://hr.example.com/cases/detail/WorkAuth/e6f56131-414d-4245-b374-e7f0d4e94919')).toBe('e6f56131')
    expect(linkLabel('https://docs.example.com/document/d/Design/edit')).toBe('Design')
    expect(linkLabel('https://acme.slack.com/archives/C0123ABC/p1726000000123456')).toBe('acme')
    expect(linkLabel('https://www.example.com/a-very-long-document-name-that-goes-on')).toHaveLength(16)
  })
})

describe('linkTagsFromField (self-report LINKS)', () => {
  it('takes the kind the session wrote, a pattern\'s key over it, and link for a bad kind', () => {
    const field = [
      '- pr: https://github.com/acme/app/pull/9',
      '- ticket: https://github.com/acme/app/issues/3',
      '- doc: https://docs.example.com/design/sync-v2.',
      '* Design Notes: https://notes.example.com/n/1',
      '- https://example.com/x',
      '- pr: https://github.com/acme/app/pull/9',
    ].join('\n')
    expect(linkTagsFromField(field, DEFAULT_LINK_PATTERNS)).toEqual([
      'pr:https://github.com/acme/app/pull/9',
      'issue:https://github.com/acme/app/issues/3',
      'doc:https://docs.example.com/design/sync-v2',
      'link:https://notes.example.com/n/1',
      'link:https://example.com/x',
    ])
  })

  it('gives a link the URL a pattern gives it, so every source agrees on one link', () => {
    const fromText = linkTagsInText('see https://acme.slack.com/archives/C01/p1726000000123456 and https://github.com/acme/app/pull/7/files', DEFAULT_LINK_PATTERNS)
    const fromField = linkTagsFromField([
      '- thread: https://acme.slack.com/archives/C01/p1726000000123456?thread_ts=1726000000.123456&cid=C01',
      '- **pr**: https://github.com/acme/app/pull/7?diff=split',
      '- [design doc](https://docs.example.com/d/sync)',
      '- **design_doc**: https://docs.example.com/d/other',
    ].join('\n'), DEFAULT_LINK_PATTERNS)
    expect(fromField.slice(0, 2)).toEqual(fromText)
    expect(fromField.slice(2)).toEqual(['link:https://docs.example.com/d/sync', 'design_doc:https://docs.example.com/d/other'])
  })

  it('reads the field out of a whole report without swallowing RECAP', () => {
    const report = 'OVERVIEW: Working.\nLINKS:\n- cr: https://reviews.example.com/r/RV-1\nRECAP: Did it.\nPHASE_SIGNAL: implement-done'
    const field = extractField(report, 'LINKS')
    expect(field).toBe('- cr: https://reviews.example.com/r/RV-1')
    expect(extractField(report, 'RECAP')).toBe('Did it.')
    expect(buildSelfReportPrompt('', 'T')).toMatch(/\nLINKS: .*"- <kind>: <url or \/absolute\/path>"/)
  })
})

describe('newLinkTags', () => {
  it('skips a URL the task holds under any key and one Walnut tagged before', () => {
    const task = { tags: ['cr:https://a.example.com/1', 'sev:2'], auto_links: ['https://a.example.com/2'] }
    expect(newLinkTags(task, [
      'pr:https://a.example.com/1',
      'pr:https://a.example.com/2',
      'pr:https://a.example.com/3',
      'pr:https://a.example.com/3',
      'sev:3',
    ])).toEqual(['pr:https://a.example.com/3'])
  })

  it('drops a tag too long to store whole: a clipped URL would open the wrong page', () => {
    const long = `design-document-with-a-long-kind:https://docs.example.com/${'a'.repeat(160)}`
    expect(long.length).toBeGreaterThan(200)
    expect(newLinkTags({}, [long, 'pr:https://a.example.com/1'])).toEqual(['pr:https://a.example.com/1'])
  })

  it('stops at the cap of link tags per task', () => {
    const tags = Array.from({ length: MAX_LINK_TAGS - 1 }, (_, i) => `link:https://a.example.com/${i}`)
    expect(newLinkTags({ tags }, ['pr:https://b.example.com/1', 'pr:https://b.example.com/2'])).toEqual(['pr:https://b.example.com/1'])
  })
})

describe('tag model and display rules for link tags', () => {
  it('stores a bare URL as a link tag, never under the key https', () => {
    expect(normalizeTag('https://example.com/a')).toBe('link:https://example.com/a')
    expect(normalizeTag('pr:https://github.com/a/b/pull/1')).toBe('pr:https://github.com/a/b/pull/1')
    expect(isNormalTag('https://example.com/a')).toBe(false)
    expect(isNormalTag('link:https://example.com/a')).toBe(true)
    expect(tagInputProblem('https://example.com/a')).toBeUndefined()
  })

  it('a link tag opens its own URL even under a key with a link rule; ids still use the rule', () => {
    const compiled = compileTagDisplay([], [{ pattern: 'ticket:*', link: 'https://tracker.example.com/{value}', source: 'plugin' }])
    expect(compiled.linkFor('pr:https://github.com/a/b/pull/1')).toBe('https://github.com/a/b/pull/1')
    expect(compiled.linkFor('ticket:https://acme.atlassian.net/browse/ENG-1')).toBe('https://acme.atlassian.net/browse/ENG-1')
    expect(compiled.linkFor('ticket:ENG-1')).toBe('https://tracker.example.com/ENG-1')
    expect(compiled.linkFor('sev:2')).toBeUndefined()
    expect(compiled.linkFor('walnut:https://example.com')).toBeUndefined()
    expect(linkUrlOfTag('sev:2')).toBeUndefined()
  })
})

describe('file-path link tags', () => {
  it('stores an absolute path as it is, refuses relative paths, whitespace and ..', () => {
    expect(canonicalLinkPath('/tmp/run/result.html')).toBe('/tmp/run/result.html')
    expect(canonicalLinkPath('`~/notes/report.md`.')).toBe('~/notes/report.md')
    expect(canonicalLinkPath('src/a.ts')).toBeUndefined()
    expect(canonicalLinkPath('/tmp/a b.html')).toBeUndefined()
    expect(canonicalLinkPath('/tmp/../etc/passwd')).toBeUndefined()
    expect(canonicalLinkPath('/')).toBeUndefined()
  })

  it('reads a file line out of LINKS beside URL lines, and labels it by file name', () => {
    const tags = linkTagsFromField([
      '- html: /tmp/run/result.html',
      '- **file**: `/Users/me/out/summary-of-the-whole-run.md`',
      '- notes: see the folder',
      '- pr: https://github.com/acme/app/pull/3',
    ].join('\n'), DEFAULT_LINK_PATTERNS)
    expect(tags).toEqual(['html:/tmp/run/result.html', 'file:/Users/me/out/summary-of-the-whole-run.md', 'pr:https://github.com/acme/app/pull/3'])
    expect(linkPathOfTag('html:/tmp/run/result.html')).toBe('/tmp/run/result.html')
    expect(linkTagLabel('html:/tmp/run/result.html')).toBe('result.html')
    expect(linkTagLabel('file:/Users/me/out/summary-of-the-whole-run.md')).toHaveLength(16)
    expect(linkUrlOfTag('html:/tmp/run/result.html')).toBeUndefined()
  })

  it('dedupes a path like a URL, under any key', () => {
    expect(newLinkTags({ tags: ['report:/tmp/run/result.html'] }, ['html:/tmp/run/result.html', 'html:/tmp/run/other.html']))
      .toEqual(['html:/tmp/run/other.html'])
  })
})
