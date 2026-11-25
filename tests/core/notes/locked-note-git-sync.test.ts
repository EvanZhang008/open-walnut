/**
 * Git sync never puts an older plain copy of a note over its lock (docs/reference/locked-notes.md):
 * when one side of a conflicted note is a locked note's file and the other is not, the locked side
 * stays, whatever the commit times say. Fake blobs only.
 */
import { describe, it, expect } from 'vitest'
import { chooseLww } from '../../../src/integrations/git-sync-merge.js'
import { buildLockedNoteText } from '../../../src/core/notes/locked-note.js'

const LOCKED = buildLockedNoteText({ id: 'n_abc', envelope: { key: 'k1', iv: 'AAAA', ct: 'BBBB' } })
const PLAIN = '---\nid: n_abc\n---\n# Week\nA plain line.\n'

function runner(blobs: Record<string, string>, times: { local: number; remote: number }) {
  return async (args: string[]) => {
    if (args[0] === 'cat-file' && args[1] === '-s') return { stdout: String(blobs[args[2]]?.length ?? 0), stderr: '', code: 0 }
    if (args[0] === 'cat-file' && args[1] === 'blob') return { stdout: blobs[args[2]] ?? '', stderr: '', code: 0 }
    if (args.includes('log')) return { stdout: String(args.includes('LOCAL') ? times.local : times.remote), stderr: '', code: 0 }
    return { stdout: '', stderr: '', code: 0 }
  }
}

describe('git sync and locked notes', () => {
  it('keeps the locked side even when the plain side committed later', async () => {
    const run = runner({ aaa: LOCKED, bbb: PLAIN }, { local: 100, remote: 200 })
    expect(await chooseLww(run as never, 'journal/Week.md', '100644 aaa', '100644 bbb', 'LOCAL', 'REMOTE')).toEqual({ side: 'local', clock: 'locked' })
    const flipped = runner({ aaa: PLAIN, bbb: LOCKED }, { local: 300, remote: 200 })
    expect(await chooseLww(flipped as never, 'journal/Week.md', '100644 aaa', '100644 bbb', 'LOCAL', 'REMOTE')).toEqual({ side: 'remote', clock: 'locked' })
  })

  it('two plain or two locked sides go by commit time as before', async () => {
    const plain = runner({ aaa: PLAIN, bbb: `${PLAIN}more\n` }, { local: 100, remote: 200 })
    expect(await chooseLww(plain as never, 'journal/Week.md', '100644 aaa', '100644 bbb', 'LOCAL', 'REMOTE')).toEqual({ side: 'remote', clock: 'commit' })
    const both = runner({ aaa: LOCKED, bbb: LOCKED.replace('BBBB', 'CCCC') }, { local: 300, remote: 200 })
    expect(await chooseLww(both as never, 'journal/Week.md', '100644 aaa', '100644 bbb', 'LOCAL', 'REMOTE')).toEqual({ side: 'local', clock: 'commit' })
  })
})
