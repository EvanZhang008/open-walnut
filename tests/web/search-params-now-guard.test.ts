import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { paramsShown } from '../../web/src/hooks/useSearchParamsNow'

/**
 * A page's own search-param write shows at once (web/src/hooks/useSearchParamsNow.ts).
 * 2026-11-24: the router's navigation is a transition, so the Org node just left stayed on screen
 * and took clicks after another was picked; a late render of the URL then showed the picked node
 * with a section the other way (truncation-peek-surfaces, full browser run).
 */
describe('paramsShown: the page\'s pick wins until the router shows it or the address bar moves', () => {
  it('shows the pick while the router still shows the URL before it', () => {
    expect(paramsShown({ next: 'node=b' }, 'node=a', 'node=b')).toEqual({ shown: 'node=b', stale: false })
  })
  it('hands over to the router once it shows the picked URL', () => {
    expect(paramsShown({ next: 'node=b' }, 'node=b', 'node=b')).toEqual({ shown: 'node=b', stale: true })
  })
  it('an older pick\'s navigation committed late never shows over the newer pick', () => {
    expect(paramsShown({ next: 'node=c' }, 'node=b', 'node=c')).toEqual({ shown: 'node=c', stale: false })
  })
  it('a navigation from elsewhere (Back, a link) drops the pick', () => {
    expect(paramsShown({ next: 'node=b' }, 'node=b', 'node=c')).toEqual({ shown: 'node=b', stale: true })
  })
  it('Back to where the pick was made, before the router showed the pick, drops it too', () => {
    // An Apps detail opened and closed fast: the router never left the grid. The hook also
    // listens for popstate there, since the router then renders nothing new.
    expect(paramsShown({ next: 'app=apps' }, '', '')).toEqual({ shown: '', stale: true })
  })
  it('with no pick it is the router\'s URL', () => {
    expect(paramsShown(null, 'node=a', 'node=b')).toEqual({ shown: 'node=a', stale: false })
  })
})

/** Every web source file, for the class guard below. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sources(full)
    return /\.(tsx?|jsx?)$/.test(name) ? [full] : []
  })
}

describe('every page that writes search params writes them through useSearchParamsNow', () => {
  const root = path.resolve(__dirname, '../../web/src')
  const hook = path.join(root, 'hooks/useSearchParamsNow.ts')
  it('no file takes the router\'s setter itself (a new member of the class fails here)', () => {
    const offenders = sources(root).filter((file) => file !== hook
      && /\[\s*\w+\s*,\s*\w+\s*\]\s*=\s*useSearchParams\s*\(/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file))
    expect(offenders).toEqual([])
  })
  it('the guard sees the pages it covers', () => {
    const users = sources(root).filter((file) => readFileSync(file, 'utf8').includes('useSearchParamsNow()'))
    expect(users.length).toBeGreaterThanOrEqual(7)
  })
})
