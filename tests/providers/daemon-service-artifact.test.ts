import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DaemonArtifactError,
  daemonArtifactExecutable,
  stageDaemonServiceArtifact,
  type DaemonArtifactErrorCode,
} from '../../src/providers/daemon-service-artifact.js'

type Fn = (...args: unknown[]) => unknown
type Hook = (real: Fn, ...args: unknown[]) => unknown

const control = vi.hoisted(() => ({ hooks: {} as Record<string, Hook | undefined> }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<Record<string, Fn>>()
  const patched: Record<string, unknown> = { ...real }
  for (const name of ['copyFile', 'rename', 'mkdir', 'chmod', 'open', 'lstat']) {
    patched[name] = (...args: unknown[]) => {
      const hook = control.hooks[name]
      return hook ? hook(real[name]!, ...args) : real[name]!(...args)
    }
  }
  return { ...patched, default: patched }
})

const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

const BYTES = Buffer.from('walnut-standalone-daemon-bytes-v1')
const OTHER = Buffer.from('walnut-standalone-daemon-bytes-v2')
const SHA = createHash('sha256').update(BYTES).digest('hex')
const EACCES = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
const EIO = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
const roots: string[] = []

afterEach(async () => {
  control.hooks = {}
  for (const dir of roots.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

async function tempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-daemon-artifact-'))
  roots.push(dir)
  return dir
}

async function sourceFile(home: string, bytes = BYTES, name = 'open-walnut-daemon'): Promise<string> {
  const file = path.join(home, name)
  await fs.writeFile(file, bytes, { mode: 0o755 })
  return file
}

async function fixture(): Promise<{ installRoot: string; source: string; versions: string }> {
  const home = await tempHome()
  const installRoot = path.join(home, 'daemon')
  return { installRoot, source: await sourceFile(home), versions: path.join(installRoot, 'versions') }
}

const writeBinary = (dir: string, bytes: Buffer, mode: number) =>
  fs.writeFile(path.join(dir, 'daemon'), bytes).then(() => fs.chmod(path.join(dir, 'daemon'), mode))
const modeOf = async (t: string) => `0${((await fs.lstat(t)).mode & 0o777).toString(8).padStart(3, '0')}`
const entries = async (dir: string): Promise<string[]> => (await fs.readdir(dir)).sort()

// We cannot really chown, so a stub raises the uid of a path by one to play a foreign owner.
const foreignUid = (stat: unknown, when: boolean): unknown => {
  if (when) (stat as { uid: number }).uid += 1
  return stat
}

const bound = (v: unknown, t: object): unknown => (typeof v === 'function' ? (v as Fn).bind(t) : v)
const syncless = (handle: object): object =>
  new Proxy(handle, { get: (t, p) => (p === 'sync' ? () => Promise.reject(EIO) : bound(Reflect.get(t, p), t)) })

async function refuses(run: () => Promise<unknown>, code: DaemonArtifactErrorCode): Promise<Error> {
  const caught: unknown = await run().then(() => null, (err: unknown) => err)
  expect(caught, `expected a ${code} failure`).toBeInstanceOf(DaemonArtifactError)
  expect((caught as DaemonArtifactError).code).toBe(code)
  expect((caught as Error).message).toMatch(/^daemon service artifact: /)
  return caught as Error
}

describe('stageDaemonServiceArtifact', () => {
  it('packs the source daemon sidecars without shipping standalone binaries', async () => {
    const root = await tempHome()
    const pkg = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8'))
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'walnut-pack-fixture', version: '1.0.0', files: pkg.files }))
    const dir = path.join(root, 'dist', 'daemon-binaries')
    await fs.mkdir(dir, { recursive: true })
    const sidecars = ['daemon-cron-runtime.cjs', 'daemon-instance-lock.cjs', 'daemon-service-cli.cjs']
    const binaries = ['daemon-linux-x64', 'daemon-linux-arm64', 'daemon-darwin-arm64', 'daemon-linux-x64.version', 'daemon-linux-x64.gz']
    for (const name of [...sidecars, ...binaries]) await fs.writeFile(path.join(dir, name), 'fixture')
    const { stdout } = await promisify(execFile)('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root, timeout: 15_000, maxBuffer: 128 * 1024,
    })
    const files = JSON.parse(stdout)[0].files.map((file: { path: string }) => file.path)
    for (const name of sidecars) expect(files).toContain(`dist/daemon-binaries/${name}`)
    for (const name of binaries) expect(files).not.toContain(`dist/daemon-binaries/${name}`)
  })

  it('publishes an immutable version directory and the foreground argv', async () => {
    const { installRoot, source, versions } = await fixture()
    const staged = await stageDaemonServiceArtifact({ sourceExecutable: source, installRoot })
    expect(staged).toEqual({ executable: path.join(versions, SHA, 'daemon'), args: ['--service'], version: SHA })
    expect(daemonArtifactExecutable(installRoot, SHA)).toBe(staged.executable)
    expect(await fs.readFile(staged.executable)).toEqual(BYTES)
    expect(await modeOf(staged.executable)).toBe('0700')
    expect(await modeOf(path.join(versions, SHA))).toBe('0700')
    expect(await modeOf(versions)).toBe('0700')
    expect(await entries(installRoot)).toEqual(['versions'])
    expect(await entries(versions)).toEqual([SHA])
    await refuses(async () => daemonArtifactExecutable(installRoot, 'not-a-digest'), 'invalidInput')
  })

  it('re-stages the same bytes without rewriting, and never removes an older version', async () => {
    const { installRoot, source, versions } = await fixture()
    const first = await stageDaemonServiceArtifact({ sourceExecutable: source, installRoot })
    const inode = (await fs.stat(first.executable)).ino
    const again = await stageDaemonServiceArtifact({ sourceExecutable: source, installRoot })
    expect(again).toEqual(first)
    expect((await fs.stat(first.executable)).ino).toBe(inode)
    const other = await sourceFile(path.dirname(installRoot), OTHER, 'open-walnut-daemon-next')
    const next = await stageDaemonServiceArtifact({ sourceExecutable: other, installRoot })
    expect(next.version).not.toBe(SHA)
    expect(await entries(versions)).toEqual([SHA, next.version].sort())
    expect(await fs.readFile(first.executable)).toEqual(BYTES)
  })

  it('reads the source through realpath, and rejects an unclean, missing, empty, non-regular or script one', async () => {
    const home = await tempHome()
    const installRoot = path.join(home, 'daemon')
    const stage = (sourceExecutable: string) => stageDaemonServiceArtifact({ sourceExecutable, installRoot })
    const source = await sourceFile(home, BYTES, 'daemon-real')
    await fs.symlink(source, path.join(home, 'daemon-link'))
    expect((await stage(path.join(home, 'daemon-link'))).version).toBe(SHA)
    for (const bad of ['', 'build/daemon', '/build/../daemon', '/build/./daemon', ' /build/daemon']) {
      await refuses(() => stage(bad), 'invalidInput')
      await refuses(() => stageDaemonServiceArtifact({ sourceExecutable: source, installRoot: bad }), 'invalidInput')
    }
    expect((await refuses(() => stage(path.join(home, 'nope')), 'unusableSource')).message).toContain('no daemon binary')
    await fs.symlink(path.join(home, 'nope'), path.join(home, 'dangling'))
    await refuses(() => stage(path.join(home, 'dangling')), 'unusableSource')
    const empty = await sourceFile(home, Buffer.alloc(0), 'empty')
    expect((await refuses(() => stage(empty), 'unusableSource')).message).toContain('is empty')
    expect((await refuses(() => stage(home), 'unusableSource')).message).toMatch(/not a regular file|cannot open/)
    const script = await sourceFile(home, Buffer.from('#!/usr/bin/env node\nrun()\n'), 'daemon.js')
    expect((await refuses(() => stage(script), 'unusableSource')).message).toContain('interpreter script')
  })

  it('refuses an install root that is a symlink, a file, shared, or foreign, and leaves it alone', async () => {
    const home = await tempHome()
    const source = await sourceFile(home)
    const stage = (installRoot: string) => stageDaemonServiceArtifact({ sourceExecutable: source, installRoot })
    await fs.mkdir(path.join(home, 'real-root'), { mode: 0o700 })
    await fs.symlink(path.join(home, 'real-root'), path.join(home, 'linked-root'))
    const linked = await refuses(() => stage(path.join(home, 'linked-root')), 'unusableInstallRoot')
    expect(linked.message).toContain('is a symlink')
    await refuses(() => stage(source), 'unusableInstallRoot')
    const withLink = path.join(home, 'root-with-link')
    await fs.mkdir(withLink, { mode: 0o700 })
    await fs.symlink(path.join(home, 'real-root'), path.join(withLink, 'versions'))
    expect((await refuses(() => stage(withLink), 'unusableInstallRoot')).message).toMatch(/versions is a symlink/)
    const shared = path.join(home, 'shared-root')
    await fs.mkdir(shared).then(() => fs.chmod(shared, 0o750))
    expect((await refuses(() => stage(shared), 'unusableInstallRoot')).message).toContain('group and other')
    expect(await modeOf(shared)).toBe('0750')
    expect(await entries(shared)).toEqual([])
    const foreign = path.join(home, 'foreign-root')
    await fs.mkdir(foreign, { mode: 0o700 })
    control.hooks.lstat = async (real, ...a) => foreignUid(await real(...a), String(a[0]) === foreign)
    expect((await refuses(() => stage(foreign), 'unusableInstallRoot')).message).toContain('owned by uid')
    expect(await entries(foreign)).toEqual([])
  })

  it('refuses a version directory it cannot vouch for, and leaves it untouched', async () => {
    const conflicts: [string, (dir: string) => Promise<unknown>, RegExp][] = [
      ['different bytes', (d) => writeBinary(d, OTHER, 0o700), /hashes [0-9a-f]{64}, expected/],
      ['no binary', async () => {}, /exists without daemon/],
      ['loose binary mode', (d) => writeBinary(d, BYTES, 0o644), /is mode 0644, expected 0700/],
      ['symlinked binary', async (d) => {
        await fs.writeFile(path.join(d, 'elsewhere'), BYTES, { mode: 0o700 })
        await fs.symlink(path.join(d, 'elsewhere'), path.join(d, 'daemon'))
      }, /daemon is a symlink/],
      ['loose directory mode', async (d) => {
        await writeBinary(d, BYTES, 0o700)
        await fs.chmod(d, 0o755)
      }, /is mode 0755, expected 0700/],
      ['foreign owner', async (d) => {
        await writeBinary(d, BYTES, 0o700)
        control.hooks.lstat = async (real, ...a) => foreignUid(await real(...a), String(a[0]) === d)
      }, /owned by uid/],
    ]
    for (const [name, prepare, message] of conflicts) {
      const { installRoot, source, versions } = await fixture()
      const versionDir = path.join(versions, SHA)
      await fs.mkdir(versionDir, { recursive: true, mode: 0o700 })
      await prepare(versionDir)
      const before = await entries(versionDir)
      const stage = () => stageDaemonServiceArtifact({ sourceExecutable: source, installRoot })
      expect((await refuses(stage, 'versionConflict')).message, name).toMatch(message)
      expect(await entries(versionDir), name).toEqual(before)
      control.hooks.lstat = undefined
    }
  })

  it('publishes nothing when the copy lands wrong bytes, fails, or cannot be staged', async () => {
    const { installRoot, source, versions } = await fixture()
    const stage = () => stageDaemonServiceArtifact({ sourceExecutable: source, installRoot })
    control.hooks.copyFile = async (_real, ...args) => {
      await fs.writeFile(args[1] as string, OTHER)
    }
    const tampered = await refuses(stage, 'stageFailed')
    expect(tampered.message).toMatch(/the copy hashes [0-9a-f]{64} \(\d+B\), expected/)
    expect(await entries(versions)).toEqual([])
    control.hooks.copyFile = () => Promise.reject(EACCES)
    const denied = await refuses(stage, 'stageFailed')
    expect(denied.message).toContain('cannot copy')
    expect((denied.cause as NodeJS.ErrnoException).code).toBe('EACCES')
    expect(await entries(versions)).toEqual([])
    control.hooks.copyFile = undefined
    control.hooks.chmod = (real, ...a) => (String(a[0]).endsWith('daemon') ? Promise.reject(EACCES) : real(...a))
    await refuses(stage, 'stageFailed')
    expect(await entries(versions)).toEqual([])
    control.hooks.chmod = undefined
    control.hooks.mkdir = (real, ...a) =>
      (a[1] as { recursive?: boolean } | undefined)?.recursive ? real(...a) : Promise.reject(EACCES)
    expect((await refuses(stage, 'stageFailed')).message).toContain('cannot create the staging directory')
    expect(await entries(versions)).toEqual([])
  })

  it('fails loudly when the staged copy or the versions directory cannot be flushed', async () => {
    const { installRoot, source, versions } = await fixture()
    const stage = () => stageDaemonServiceArtifact({ sourceExecutable: source, installRoot })
    let breakSync = /\/daemon$/
    control.hooks.open = async (real, ...a) => {
      const handle = (await real(...a)) as object
      return breakSync.test(String(a[0])) ? syncless(handle) : handle
    }
    expect((await refuses(stage, 'stageFailed')).message).toMatch(/cannot flush .*daemon to disk/)
    expect(await entries(versions)).toEqual([])
    breakSync = /versions$/
    expect((await refuses(stage, 'stageFailed')).message).toMatch(/cannot flush .*versions to disk/)
    expect(await entries(versions)).toEqual([SHA])
  })

  it('cleans up a failed publish, and adopts a version a racing writer published first', async () => {
    const { installRoot, source, versions } = await fixture()
    const stage = () => stageDaemonServiceArtifact({ sourceExecutable: source, installRoot })
    control.hooks.rename = () => Promise.reject(EACCES)
    const err = await refuses(stage, 'stageFailed')
    expect(err.message).toContain('cannot publish')
    expect((err.cause as NodeJS.ErrnoException).code).toBe('EACCES')
    expect(await entries(versions)).toEqual([])
    control.hooks.rename = async (real, ...a) => {
      const to = String(a[1])
      await fs.mkdir(to, { recursive: true, mode: 0o700 })
      await writeBinary(to, BYTES, 0o700)
      await fs.chmod(to, 0o700)
      return real(...a)
    }
    const staged = await stage()
    expect(staged.executable).toBe(path.join(versions, SHA, 'daemon'))
    expect(await entries(versions)).toEqual([SHA])
  })
})
