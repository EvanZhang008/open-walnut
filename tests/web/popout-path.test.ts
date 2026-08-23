import { describe, expect, it } from 'vitest'
import { isPopoutPath } from '../../web/src/popout/openPopout.js'

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
