/**
 * The scan's fast classifier (makeFileClass) must give the same class as the manifest's own
 * homePathClass for every path: it decides which files a batch holds. Checked for every place
 * the manifest names (and names inside and beside each), so a new entry the shortcut would
 * misjudge fails here.
 */
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { homeEntries, homePathClass } from '../../../src/core/home-manifest/index.js'
import { makeFileClass } from '../../../src/core/standby/scan.js'

function samples(): string[] {
  const out = new Set<string>()
  const names = ['x.md', 'standby-probe-name', 'a.json', 'b.sqlite', 'b.sqlite-wal', '.DS_Store', '.open-walnut-1.tmp', 'x.lock', 'x.json.bak', 'note.md.conflicted-1', 'chat-history-2.json', 'reconcile-a.json']
  for (const e of homeEntries()) {
    if (!e.path) continue
    out.add(e.path)
    const dir = path.posix.dirname(e.path)
    for (const n of names) {
      out.add(`${e.path}/${n}`)
      out.add(`${e.path}/deep/${n}`)
      out.add(dir === '.' ? n : `${dir}/${n}`)
      out.add(`${e.path}${n.startsWith('.') ? '' : '.'}${n}`)
    }
  }
  for (const n of names) out.add(`user-own-folder/${n}`)
  return [...out].filter((p) => !p.endsWith('/'))
}

describe('makeFileClass', () => {
  it('agrees with homePathClass for every manifest place and the names around it', () => {
    const fast = makeFileClass()
    const wrong: string[] = []
    const all = samples()
    for (const rel of all) {
      const dir = path.posix.dirname(rel)
      const got = fast(dir === '.' ? '' : dir, path.posix.basename(rel))
      if (got !== homePathClass(rel)) wrong.push(`${rel}: ${got} != ${homePathClass(rel)}`)
    }
    expect(all.length).toBeGreaterThan(1000)
    expect(wrong).toEqual([])
  })
})
