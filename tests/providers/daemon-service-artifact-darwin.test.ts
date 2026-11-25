/**
 * What a Mac host's service install root needs that a Linux one does not (daemon-service-artifact.ts):
 *   - the staged copy loses com.apple.quarantine (copyFile keeps a source's marks; Gatekeeper would
 *     refuse the ad-hoc signed walnut file with a dialog nobody at a host sees), the copy only;
 *   - old versions are pruned there too, judged by what ps says runs (a walnut file is ~100 MB a
 *     version); where nothing can tell what runs, nothing is removed.
 * MACHINE SAFETY: temp dirs only; no process is started (the runners are fakes).
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pruneDaemonServiceVersions, quarantineClearer, runningExecutables, stageDaemonServiceArtifact } from '../../src/providers/daemon-service-artifact.js'

const roots: string[] = []
afterEach(async () => { for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true }) })

async function layout() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-artifact-darwin-'))
  roots.push(root)
  const source = path.join(root, 'walnut')
  await fs.writeFile(source, Buffer.from('walnut-file-bytes'), { mode: 0o755 })
  return { root, source, installRoot: path.join(root, 'install') }
}

describe('the staged copy on a Mac', () => {
  it('loses its quarantine mark: the copy, never the source; its bytes stay', async () => {
    const l = await layout()
    const cleared: string[] = []
    const staged = await stageDaemonServiceArtifact({ ...l, sourceExecutable: l.source, platform: 'darwin', clearQuarantine: async (f) => { cleared.push(f) } })
    // The staging dir's copy, before it was published under the version dir.
    expect(cleared).toHaveLength(1)
    expect(cleared[0]).toMatch(new RegExp(`${l.installRoot}/versions/\\.staging-[0-9a-f]{12}-[0-9a-f]{12}/daemon$`))
    expect(cleared[0]).not.toBe(l.source)
    expect(createHash('sha256').update(await fs.readFile(staged.executable)).digest('hex')).toBe(staged.version)
  })

  it('a clear that fails is no failure of the install; on Linux nothing is cleared', async () => {
    const l = await layout()
    await expect(stageDaemonServiceArtifact({ ...l, sourceExecutable: l.source, platform: 'darwin', clearQuarantine: async () => { throw new Error('xattr: no such xattr') } })).resolves.toMatchObject({ args: ['--service'] })
    const clear = vi.fn(async () => {})
    await stageDaemonServiceArtifact({ ...l, sourceExecutable: l.source, platform: 'linux', clearQuarantine: clear })
    expect(clear).not.toHaveBeenCalled()
  })

  it('the clearer runs xattr -d on that file alone', async () => {
    const calls: Array<[string, string[]]> = []
    await quarantineClearer((file, args, _o, cb) => { calls.push([file, args]); cb(new Error('No such xattr'), '') })('/x/versions/.staging-1/daemon')
    expect(calls).toEqual([['/usr/bin/xattr', ['-d', 'com.apple.quarantine', '/x/versions/.staging-1/daemon']]])
  })
})

describe('pruning old versions on a Mac', () => {
  async function versions(n: number) {
    const l = await layout()
    const shas: string[] = []
    for (let i = 0; i < n; i++) {
      const sha = String(i).repeat(64).slice(0, 64)
      await fs.mkdir(path.join(l.installRoot, 'versions', sha), { recursive: true, mode: 0o700 })
      await fs.writeFile(path.join(l.installRoot, 'versions', sha, 'daemon'), 'x', { mode: 0o700 })
      shas.push(sha)
    }
    await fs.chmod(path.join(l.installRoot, 'versions'), 0o700)
    return { ...l, shas, exe: (sha: string) => path.join(l.installRoot, 'versions', sha, 'daemon') }
  }

  it('keeps the kept ones and any ps names, removes the rest', async () => {
    const v = await versions(4)
    const ps = (file: string, args: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => {
      expect([file, args]).toEqual(['/bin/ps', ['-axww', '-o', 'comm=']])
      cb(null, `/sbin/launchd\n${v.exe(v.shas[2]!)}\n/usr/bin/ssh\n`)
    }
    const removed = await pruneDaemonServiceVersions(v.installRoot, [v.exe(v.shas[0]!)], { platform: 'darwin', execFile: ps })
    expect(removed.map((d) => path.basename(d)).sort()).toEqual([v.shas[1], v.shas[3]])
  })

  it('removes nothing when what runs cannot be told: no runner, or ps failed', async () => {
    const v = await versions(3)
    expect(await pruneDaemonServiceVersions(v.installRoot, [], { platform: 'darwin' })).toEqual([])
    expect(await pruneDaemonServiceVersions(v.installRoot, [], { platform: 'darwin', execFile: (_f, _a, _o, cb) => cb(new Error('ps: not allowed'), '') })).toEqual([])
    expect(await runningExecutables('win32')).toBeNull()
    expect((await fs.readdir(path.join(v.installRoot, 'versions'))).sort()).toEqual(v.shas)
  })
})
