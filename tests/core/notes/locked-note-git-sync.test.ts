/**
 * Git sync never puts a plain copy of a note over its lock (docs/reference/locked-notes.md): when
 * one side of a conflicted note is a locked note's file and the other is not, the locked side
 * stays, whatever the commit times say. Both conflict deciders take the one decision
 * (git-sync-rewrite-carry.ts contentDecision): a diverged pull (chooseLww, fake blobs) and the
 * replay of local commits across a hub history rewrite (carryLocalCommits, a real repo, with and
 * without `merge-tree --merge-base`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chooseLww } from '../../../src/integrations/git-sync-merge.js'
import { carryLocalCommits, type GitStatusRunner } from '../../../src/integrations/git-sync-rewrite-carry.js'
import { execGitArgsStatus } from '../../../src/integrations/git-sync.js'
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

describe('the replay across a hub history rewrite keeps the locked side', () => {
  let repo: string
  const sh = (cmd: string, env?: Record<string, string>) =>
    execSync(cmd, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } }).trim()
  const write = (f: string, v: string) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), v) }
  const run: GitStatusRunner = (args, opts) => execGitArgsStatus(args, { cwd: repo, timeout: 30_000, ...opts })
  /** A git without `merge-tree --merge-base` (before 2.40): the replay runs file by file. */
  const oldGit: GitStatusRunner = async (args, opts) => (args.includes('merge-tree')
    ? { code: 129, stdout: '', stderr: "error: unknown option `merge-base'" } : run(args, opts))
  const index = () => path.join(repo, '.git', 'carry-locked.index')
  const NOTE = 'journal/Week.md'
  const at = (offsetS: number) => ({ GIT_COMMITTER_DATE: `${Math.floor(Date.now() / 1000) + offsetS} +0000` })

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-locked-'))
    sh('git init -q -b main && git config user.email t@t && git config user.name t')
    write(NOTE, PLAIN); write('other.md', 'other\n')
    sh('git add -A && git commit -q -m base')
  })
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }))

  /**
   * The hub's rebuilt chain: one fresh root holding `files` over the base tree, committed `offsetS`
   * from now. As a scrub of base, it keeps base's author date and subject (the replay matches it so).
   */
  function rebuilt(files: Record<string, string>, offsetS: number, scrubOf?: string): string {
    const base = sh('git rev-parse HEAD')
    sh(`git checkout -q --detach ${base}`)
    for (const [f, v] of Object.entries(files)) write(f, v)
    sh('git add -A')
    const stamp = scrubOf ? { GIT_AUTHOR_DATE: sh(`git log -1 --format=%ad --date=raw ${scrubOf}`) } : {}
    const tip = sh(`git commit-tree ${sh('git write-tree')} -m ${scrubOf ? 'base' : 'rebuilt'}`, { ...at(offsetS), ...stamp })
    sh('git checkout -q -f main')
    return tip
  }

  /** Both replays (merge-tree, and file by file), and the note in what each lands on (null: none). */
  async function carry(head: string, tip: string, base: string) {
    const out = []
    for (const git of [run, oldGit]) {
      const r = await carryLocalCommits(git, head, tip, index(), base)
      const landed = r.head ?? tip
      let note: string | null = null
      try { note = execSync(`git show ${landed}:${NOTE}`, { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }) } catch { /* removed */ }
      out.push({ r, note })
    }
    return out
  }

  it('the hub locked the note, this box edited its plain copy later: the locked note stays', async () => {
    const base = sh('git rev-parse HEAD')
    const tip = rebuilt({ [NOTE]: LOCKED }, -600)
    write(NOTE, `${PLAIN}A plain line typed later.\n`); write('other.md', 'other, edited\n')
    sh('git add -A && git commit -q -m mine')
    for (const { r, note } of await carry(sh('git rev-parse HEAD'), tip, base)) {
      expect(note).toBe(LOCKED)
      expect(r.keptRemote).toContain(NOTE)
      // The rest of the local commit is carried as before.
      expect(sh(`git show ${r.head}:other.md`)).toBe('other, edited')
    }
  })

  it('this box locked the note, the hub holds a plain edit made later: the locked note stays', async () => {
    const base = sh('git rev-parse HEAD')
    // A scrub of base the hub made after this box locked the note, its plain edit newer than the lock.
    const tip = rebuilt({ [NOTE]: `${PLAIN}A plain line from the hub.\n` }, 600, base)
    write(NOTE, LOCKED)
    sh('git add -A && git commit -q -m lock')
    for (const { r, note } of await carry(sh('git rev-parse HEAD'), tip, base)) {
      expect(note).toBe(LOCKED)
      expect(r.keptLocal).toContain(NOTE)
    }
  })

  it('this box deleted the note the hub holds locked: the locked note stays', async () => {
    const base = sh('git rev-parse HEAD')
    const tip = rebuilt({ [NOTE]: LOCKED }, -600)
    sh(`git rm -q ${NOTE} && git commit -q -m drop`)
    for (const { r, note } of await carry(sh('git rev-parse HEAD'), tip, base)) {
      expect(note).toBe(LOCKED)
      expect(r.keptRemote).toContain(NOTE)
    }
  })

  it('two plain sides still go by commit time', async () => {
    const base = sh('git rev-parse HEAD')
    const tip = rebuilt({ [NOTE]: `${PLAIN}hub\n` }, -600)
    write(NOTE, `${PLAIN}mine\n`)
    sh('git add -A && git commit -q -m mine')
    for (const { note } of await carry(sh('git rev-parse HEAD'), tip, base)) expect(note).toBe(`${PLAIN}mine\n`)
  })
})
