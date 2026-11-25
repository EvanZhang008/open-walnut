/**
 * The data repo's .gitignore is leader data (home-entries.ts data-repo-ignore), and what that
 * changes and does not change, each read from the code that uses the class.
 *
 * Found by a 20 GB leader switch rehearsal between machines (2026-11-24): classed rebuildable, the
 * standby left it out while it copied `.git`, so a promoted home had none, and its auto-commit took
 * in tmp/ and /voice-archive/. The user may add rules to it, so it moves with the leader.
 *
 * Checked here, on a temp home:
 *  - the standby's batch copies it (it did not);
 *  - the old-home rule (home-kept compareKept) counts a change to it (it skipped it);
 *  - the restore drill's must-have list requires it in a backup (it skipped it), and a backup
 *    that holds it passes; its not-in-backups list does not name it (as before);
 *  - the backup itself takes it as it did: its rules (scan.ts) never read the manifest's class.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyHomePath } from '../../../src/core/home-manifest/index.js'
import { compareKept, snapshotHome } from '../../../src/core/home-manifest/home-kept.js'
import { snapshotTo } from '../../../src/core/standby/index.js'
import { backupTakes, scanDataDir } from '../../../src/core/backup/scan.js'
import { checkMustHave, notInBackups } from '../../../src/core/backup/restore-drill-checks.js'
import type { TreeEntry } from '../../../src/core/backup/repo/format.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    const open = (p: string) => { try { fs.chmodSync(p, 0o700) } catch { return } for (const e of fs.readdirSync(p, { withFileTypes: true })) if (e.isDirectory()) open(path.join(p, e.name)) }
    open(d)
    fs.rmSync(d, { recursive: true, force: true })
  }
})

function home(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitignore-class-'))
  dirs.push(root)
  const h = path.join(root, 'home')
  fs.mkdirSync(path.join(h, 'notes'), { recursive: true })
  fs.writeFileSync(path.join(h, 'notes', 'a.md'), 'a\n')
  fs.writeFileSync(path.join(h, '.gitignore'), 'tmp/\n/voice-archive/\n# a rule of the user\'s\n/scratch-of-mine/\n')
  return h
}

const tree = (paths: string[]): TreeEntry[] => paths.map((p) => ({ p, s: 1, m: 0, b: [] }) as unknown as TreeEntry)

describe('the .gitignore is leader data', () => {
  it('the manifest says so', () => {
    expect(classifyHomePath('.gitignore')).toMatchObject({ id: 'data-repo-ignore', class: 'leader-data' })
  })

  it('a standby batch copies it, byte for byte', async () => {
    const h = home()
    const target = path.join(path.dirname(h), 'standby')
    const out = await snapshotTo(h, target)
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    expect(fs.readFileSync(path.join(target, 'copy', '.gitignore'), 'utf8')).toBe(fs.readFileSync(path.join(h, '.gitignore'), 'utf8'))
  })

  it('the old-home rule counts a change to it', async () => {
    const h = home()
    const before = await snapshotHome(h)
    fs.appendFileSync(path.join(h, '.gitignore'), '/another/\n')
    const v = compareKept(before, await snapshotHome(h))
    expect(v.ok).toBe(false)
    expect(v.changed).toEqual([{ path: '.gitignore', cls: 'leader-data', how: 'changed' }])
  })

  it('the restore drill requires it in a backup: one without it fails the must-have check, one with it passes', async () => {
    const h = home()
    const later = new Date(Date.now() + 3_600_000).toISOString()
    const without = await checkMustHave(h, tree(['notes/a.md']), later, 0)
    expect(without.ok).toBe(false)
    expect(without.problems?.join('\n')).toMatch(/^data-repo-ignore: 1 file\(s\).*\.gitignore/m)
    const withIt = await checkMustHave(h, tree(['notes/a.md', '.gitignore']), later, 0)
    expect(withIt.ok, JSON.stringify(withIt)).toBe(true)
    expect(withIt.detail).toMatch(/^2 leader-data files/)
    expect((await notInBackups(h, {})).map((e) => e.id)).not.toContain('data-repo-ignore')
  })

  it('the backup takes it as before: its rules do not read the class', async () => {
    const h = home()
    expect(backupTakes('.gitignore')).toBe('raw')
    expect((await scanDataDir(h)).map((e) => e.path)).toContain('.gitignore')
    const scan = fs.readFileSync(path.join(__dirname, '../../../src/core/backup/scan.ts'), 'utf8')
    expect(scan).not.toMatch(/home-manifest/)
  })
})
