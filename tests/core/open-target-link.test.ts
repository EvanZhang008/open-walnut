/**
 * The open link a launcher uses to open a place in Walnut (src/core/open-target-link.ts): only a
 * path inside the console comes out, never another origin or a script.
 */
import { describe, expect, it } from 'vitest'
import { buildOpenTargetLink, parseOpenTargetLink } from '../../src/core/open-target-link.js'

describe('open-walnut://open links', () => {
  it('round-trips a task path', () => {
    const link = buildOpenTargetLink('/tasks/mvwro6xe-cdab')
    expect(link).toBe('open-walnut://open?to=%2Ftasks%2Fmvwro6xe-cdab')
    expect(parseOpenTargetLink(link)).toBe('/tasks/mvwro6xe-cdab')
    expect(parseOpenTargetLink('OPEN-WALNUT://open?to=/')).toBe('/')
    expect(parseOpenTargetLink('open-walnut:open?to=/org')).toBe('/org')
    expect(parseOpenTargetLink('open-walnut://open?to=/sessions?id=abc')).toBe('/sessions?id=abc')
    expect(parseOpenTargetLink(buildOpenTargetLink('/sessions?id=abc&tab=inbox&letter=l1'))).toBe('/sessions?id=abc&tab=inbox&letter=l1')
    // A note: the vault path is encoded inside the target, spaces and # included.
    const note = `/notes?path=${encodeURIComponent('work/plans/Q4 plan #2.md')}`
    expect(parseOpenTargetLink(buildOpenTargetLink(note))).toBe(note)
  })

  it('refuses anything that is not a path inside the console', () => {
    for (const bad of [
      'open-walnut://open?to=https://evil.example/',
      'open-walnut://open?to=//evil.example/x',
      'open-walnut://open?to=javascript:alert(1)',
      'open-walnut://open?to=/javascript:alert(1)',
      'open-walnut://open?to=tasks/x',
      'open-walnut://open?to=/a%20b',
      'open-walnut://open?to=/a\\b',
      'open-walnut://open?to=/x"onload=1',
      'open-walnut://open?to=' + '/' + 'a'.repeat(600),
      // A page switch rides a query: only a session's or a note's own keys may come from outside.
      'open-walnut://open?to=' + encodeURIComponent('/?walnut-test-run=x'),
      'open-walnut://open?to=' + encodeURIComponent('/tasks/x?walnut-test-run=x'),
      'open-walnut://open?to=' + encodeURIComponent('/sessions?id=abc&walnut-test-run=x'),
      'open-walnut://open?to=' + encodeURIComponent('/sessions?tab=inbox'),
      'open-walnut://open?to=' + encodeURIComponent('/notes?path=a.md&walnut-test-run=x'),
      'open-walnut://open?to=' + encodeURIComponent('/notes?id=abc'),
      'open-walnut://open?to=' + encodeURIComponent('/notes?path='),
      'open-walnut://open?to=' + encodeURIComponent('/org?path=a.md'),
      'open-walnut://open?to=' + encodeURIComponent('/tasks/x#frag'),
      'open-walnut://open',
      'open-walnut://install-plugin?url=git@x:y.git',
      'https://openwalnut.dev/open?to=/tasks/x',
      'not a link',
    ]) {
      expect(parseOpenTargetLink(bad), bad).toBeNull()
    }
  })
})
