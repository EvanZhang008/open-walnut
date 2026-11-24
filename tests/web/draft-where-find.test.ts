/** The Where picker's data rules (design A): used folders, Recent / Most used, search order, levels. */
import { describe, expect, it } from 'vitest'
import {
  foldLevels, matchFolder, mostUsedFolders, parentLevel, pathLevels, placesOn, recentFolders, searchFolders, typedBrowse, usedFolders,
} from '../../web/src/components/sessions/draft-where-find'

const NOW = Date.parse('2026-11-24T12:00:00Z')
const at = (daysAgo: number) => new Date(NOW - daysAgo * 864e5).toISOString()
const dir = (cwd: string, host: string | null, count: number, daysAgo: number) => ({ cwd, host, project: '', count, lastUsed: at(daysAgo) })
const homeOf = (h: string) => (h === '__local__' ? '/Users/sam' : '/home/sam')

describe('used folders', () => {
  it('one row per machine and folder, starts added, Walnut-made folders left out', () => {
    const used = usedFolders([
      dir('/home/sam/code/marina', 'devbox', 3, 2), dir('/home/sam/code/marina/', 'devbox', 2, 1),
      dir('/home/sam/.open-walnut-worktrees/marina/task-1', 'devbox', 9, 0),
      dir('/home/sam/.local/state/open-walnut/tasks/abc', 'devbox', 9, 0),
      dir('/Users/sam/code/marina', null, 1, 5),
    ])
    expect(used.map((u) => `${u.host}:${u.cwd}:${u.count}`).sort()).toEqual(['__local__:/Users/sam/code/marina:1', 'devbox:/home/sam/code/marina:5'])
    expect(used.find((u) => u.host === 'devbox')?.last).toBe(at(1))
  })

  it('Recent is the last 10 by time, Most used the 10 with the most starts', () => {
    const used = usedFolders(Array.from({ length: 14 }, (_, i) => dir(`/home/sam/p${i}`, 'devbox', 14 - i, i)))
    expect(recentFolders(used).map((u) => u.cwd)).toEqual(Array.from({ length: 10 }, (_, i) => `/home/sam/p${i}`))
    const most = mostUsedFolders(usedFolders([dir('/a/x', null, 1, 0), dir('/a/y', null, 50, 9), dir('/a/z', null, 7, 3)]))
    expect(most.map((u) => u.cwd)).toEqual(['/a/y', '/a/z', '/a/x'])
  })
})

describe('search', () => {
  it('match classes: in the name, then in the path, then the letters in order', () => {
    expect(matchFolder('mar', '~/code/marina')?.tier).toBe(3)
    expect(matchFolder('code', '~/code/marina')?.tier).toBe(2)
    expect(matchFolder('mrn', '~/code/marina')?.tier).toBe(1)
    expect(matchFolder('zzz', '~/code/marina')).toBeNull()
  })

  it('a query with / matches piece by piece, a typo inside a piece too', () => {
    expect(matchFolder('code/mrina', '~/work/code/marina')).not.toBeNull()
    expect(matchFolder('code/marina', '~/work/other/marina')).toBeNull()
    // The last piece is the folder's own name.
    expect(matchFolder('marina/code', '~/marina/code/x')).toBeNull()
  })

  it('a used folder ranks above every unused one, by its starts', () => {
    const used = usedFolders([dir('/home/sam/eks-tools', 'devbox', 2, 1), dir('/home/sam/old/eks', 'devbox', 40, 20)])
    const listed = [{ host: 'devbox', cwd: '/home/sam/eks' }]
    const hits = searchFolders('eks', used, listed, homeOf, NOW)
    expect(hits.map((h) => h.shown)).toEqual(['~/old/eks', '~/eks-tools', '~/eks'])
    expect(hits[2].used).toBeUndefined()
  })

  it('finds folders on every machine', () => {
    const used = usedFolders([dir('/Users/sam/notes', null, 1, 1), dir('/home/sam/notes', 'devbox', 1, 2)])
    expect(searchFolders('notes', used, [], homeOf, NOW).map((h) => h.host)).toEqual(['__local__', 'devbox'])
  })
})

describe('levels', () => {
  it('a path as its levels, folded past 6', () => {
    expect(pathLevels('~/a/b').map((l) => l.dir)).toEqual(['~', '~/a', '~/a/b'])
    expect(pathLevels('/srv/x').map((l) => l.label)).toEqual(['/', 'srv', 'x'])
    const { shown, folded } = foldLevels(pathLevels('/a/b/c/d/e/f/g'))
    expect(shown.map((l) => (l === 'fold' ? '…' : l.label))).toEqual(['/', '…', 'e', 'f', 'g'])
    expect(folded.map((l) => l.label)).toEqual(['a', 'b', 'c', 'd'])
    expect(parentLevel('~/a')).toBe('~')
    expect(parentLevel('~')).toBe('~')
  })

  it('a typed path browses its folder and filters by the piece after the last /', () => {
    expect(typedBrowse('~/code/')).toEqual({ dir: '~/code', filter: '' })
    expect(typedBrowse('~/code/mar')).toEqual({ dir: '~/code', filter: 'mar' })
    expect(typedBrowse('/srv')).toEqual({ dir: '/', filter: 'srv' })
    expect(typedBrowse('~')).toEqual({ dir: '~', filter: '' })
    expect(typedBrowse('marina')).toBeNull()
  })

  it('places outside the home come from the used folders, most used first', () => {
    const used = usedFolders([dir('/srv/data/a', 'devbox', 3, 1), dir('/srv/data/b', 'devbox', 3, 1), dir('/opt/tools/x', 'devbox', 1, 1), dir('/home/sam/y', 'devbox', 99, 1)])
    expect(placesOn('devbox', used, '/home/sam')).toEqual(['/srv/data', '/opt/tools'])
  })
})
