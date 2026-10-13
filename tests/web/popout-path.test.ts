import { describe, expect, it } from 'vitest'
import { isPopoutPath, popoutPath } from '../../web/src/popout/openPopout.js'

describe('popout route matching', () => {
  it.each([
    ['/popout', true],
    ['/popout/session', true],
    ['/popouts', false],
    ['/popoutish/session', false],
  ])('matches %s without claiming sibling routes', (pathname, expected) => {
    expect(isPopoutPath(pathname)).toBe(expected)
  })
})

describe('popoutPath', () => {
  it('builds the pop-out path a link inside a pop-out stays on', () => {
    expect(popoutPath('task', { id: 'abc-123' })).toBe('/popout?view=task&id=abc-123')
    expect(popoutPath('file', { path: '/a b/c.md', line: 4, host: '', cwd: null })).toBe('/popout?view=file&path=%2Fa+b%2Fc.md&line=4')
    expect(isPopoutPath(popoutPath('task', { id: 'x' }).split('?')[0]!)).toBe(true)
  })
})
