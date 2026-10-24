/**
 * The field rehearsal's pieces (scripts/release-rehearsal/field*.mjs): the
 * release an existing install updates to, packed as a release publishes it now
 * (the launcher and its platform packages), at a version above npm's `latest`;
 * the start points it updates from; and a registry that can name the release a
 * person runs today before the update arrives. Offline: the packed files are
 * small scripts, and the "published" version is a document made here.
 *
 * The rehearsal itself (the real 0.6.x from npm and its GitHub Release, the
 * compiled file) runs in CI's field job: run.mjs --field latest --field-packs.
 */
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fieldDistBin, fieldVersions, packVersion, readFieldJson, writeFieldJson } from '../../scripts/release-rehearsal/field-packs.mjs'
import { nodeForm, pruneToLogs, releaseArchive, startPointsOf } from '../../scripts/release-rehearsal/field.mjs'
import { buildPackument, startRegistry } from '../../scripts/release-rehearsal/registry.mjs'
import { compareVersions } from '../../scripts/release-rehearsal/version-order.mjs'
import { TARGETS, builtName } from '../../scripts/release-files.mjs'

const ROOT = path.resolve(__dirname, '../..')
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'field-rehearsal-test-')))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
const HOST = `${process.platform}-${process.arch}`

describe('fieldVersions', () => {
  it('is a prerelease of the patch above every version it is given, and the one after it is newer', () => {
    const v = fieldVersions(['0.6.17', '0.6.18-nightly.20261023.268', '0.6.14'])
    expect(v).toEqual({ release: '0.6.19-rehearsal.1', next: '0.6.19-rehearsal.2' })
    for (const from of ['0.6.17', '0.6.18-nightly.20261023.268']) expect(compareVersions(v.release, from), from).toBeGreaterThan(0)
    expect(compareVersions(v.next, v.release)).toBeGreaterThan(0)
  })

  it('goes above package.json when that is ahead of the registry, skips what is not a version, and needs one', () => {
    expect(fieldVersions(['0.6.17', '0.7.2']).release).toBe('0.7.3-rehearsal.1')
    expect(compareVersions(fieldVersions(['0.6.18', '0.6.18']).release, '0.6.18')).toBeGreaterThan(0)
    expect(fieldVersions([null, '0.6.14']).release).toBe('0.6.15-rehearsal.1')
    expect(() => fieldVersions([null])).toThrow('no version to go above')
  })
})

describe('startPointsOf', () => {
  const doc = (versions: Record<string, object>, tags: Record<string, string>) => ({ 'dist-tags': tags, versions })
  const launcher = { optionalDependencies: { '@open-walnut/darwin-arm64': 'x' } }

  it('is npm\'s latest and nightly while both are still the Node package', () => {
    const r = startPointsOf(doc({ '0.6.16': {}, '0.6.17': {}, '0.6.18-nightly.268': {} }, { latest: '0.6.17', nightly: '0.6.18-nightly.268' }))
    expect(r).toEqual({ latest: '0.6.17', nightly: '0.6.18-nightly.268', lastNode: '0.6.17', points: ['0.6.17', '0.6.18-nightly.268'] })
  })

  it('keeps the newest stable Node package once latest is a launcher, so that step stays rehearsed', () => {
    const r = startPointsOf(doc({ '0.6.16': {}, '0.6.17': {}, '0.6.18': launcher, '0.6.19': launcher }, { latest: '0.6.19', nightly: '0.6.19' }))
    expect(r.points).toEqual(['0.6.19', '0.6.17'])
    expect(r.lastNode).toBe('0.6.17')
  })

  it('leaves out a nightly tag that names no version, and needs a latest', () => {
    expect(startPointsOf(doc({ '0.6.17': {} }, { latest: '0.6.17', nightly: '0.6.18-gone' })).points).toEqual(['0.6.17'])
    expect(() => startPointsOf({ 'dist-tags': {}, versions: {} })).toThrow('names no latest')
  })

  it('tells the forms apart by the platform packages a launcher names', () => {
    expect(nodeForm({ dependencies: { express: '5' } })).toBe(true)
    expect(nodeForm(launcher)).toBe(false)
  })
})

describe('pruneToLogs', () => {
  it('keeps a finished scenario\'s logs and nothing of its install', () => {
    const dir = path.join(tmp, 'pruned')
    const files = ['log.txt', 'npm-install-1.0.0.txt', 'daemon/daemon-d-1.log', 'daemon/walnut-daemon-x', 'prefix/lib/node_modules/open-walnut/package.json', 'home/.open-walnut/tasks/tasks.sqlite', 'project/a.ts']
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
      fs.writeFileSync(path.join(dir, f), 'x')
    }
    pruneToLogs(dir)
    expect(files.filter((f) => fs.existsSync(path.join(dir, f)))).toEqual(['log.txt', 'npm-install-1.0.0.txt', 'daemon/daemon-d-1.log'])
    expect(fs.readdirSync(dir).sort()).toEqual(['daemon', 'log.txt', 'npm-install-1.0.0.txt'])
    pruneToLogs(path.join(tmp, 'never-made'))
  })
})

describe('releaseArchive: the archive a stable release ships, as its users installed it', () => {
  const name = `open-walnut-1.2.3-${process.platform}-${process.arch}.tar.gz`
  const bytes = Buffer.from('an archive')
  const sha = crypto.createHash('sha256').update(bytes).digest('hex')
  const assets = (sums: string, files: Record<string, Buffer> = { [name]: bytes, 'install.sh': Buffer.from('#!/bin/sh\n') }) => async (url: string) => {
    if (url.endsWith('/SHA256SUMS')) return Buffer.from(sums)
    const file = url.slice(url.lastIndexOf('/') + 1)
    return files[file] ?? null
  }

  it('takes this machine\'s archive and the release\'s own install.sh, checked against its SHA256SUMS', async () => {
    const dir = path.join(tmp, 'release-ok')
    const got = await releaseArchive('1.2.3', dir, { base: 'https://releases.example', get: assets(`${'0'.repeat(64)}  other.tar.gz\n${sha}  ${name}\n`) })
    expect(got).toEqual({ archive: path.join(dir, name), installSh: path.join(dir, 'install.sh') })
    expect(fs.readFileSync(got!.archive)).toEqual(bytes)
  })

  it('is nothing for a release with no archive for this machine, and refuses one that does not match', async () => {
    expect(await releaseArchive('1.2.3', path.join(tmp, 'release-none'), { get: assets(`${sha}  open-walnut-1.2.3-plan9-mips.tar.gz\n`) })).toBeNull()
    expect(await releaseArchive('1.2.3', path.join(tmp, 'release-none'), { get: async () => null })).toBeNull()
    await expect(releaseArchive('1.2.3', path.join(tmp, 'release-bad'), { get: assets(`${'f'.repeat(64)}  ${name}\n`) })).rejects.toThrow("does not match v1.2.3's SHA256SUMS")
    expect(fs.existsSync(path.join(tmp, 'release-bad'))).toBe(false)
    await expect(releaseArchive('1.2.3', path.join(tmp, 'release-gone'), { get: assets(`${sha}  ${name}\n`, {}) })).rejects.toThrow('does not serve it')
  })
})

describe('registry: a released version beside the served tarballs', () => {
  const published = { '0.0.1': { name: 'open-walnut', version: '0.0.1', dist: { tarball: 'https://registry.example/open-walnut/-/open-walnut-0.0.1.tgz' } } }

  it('may be named by a dist-tag, keeps its own tarball URL, and is older than every served version', () => {
    const doc = buildPackument({ tarballs: [], distTags: { latest: '0.0.1' }, baseUrl: 'http://r', published })
    expect(doc['dist-tags'].latest).toBe('0.0.1')
    expect(doc.versions['0.0.1'].dist.tarball).toBe('https://registry.example/open-walnut/-/open-walnut-0.0.1.tgz')
    expect(() => buildPackument({ tarballs: [], distTags: { latest: '0.0.2' }, baseUrl: 'http://r', published })).toThrow('not served')
  })
})

describe('field-packs: the release as a release publishes it', () => {
  const stub = (version: string) => {
    const dir = path.join(tmp, `built-${version}`)
    fs.mkdirSync(dir, { recursive: true })
    const f = path.join(dir, builtName(HOST))
    fs.writeFileSync(f, `#!/bin/sh\necho '${version} (stub)'\n`, { mode: 0o755 })
    return { [HOST]: f }
  }

  it('fills every target the launcher names, a placeholder where nothing was compiled', () => {
    const dir = fieldDistBin(path.join(tmp, 'bin'), '9.9.9', stub('9.9.9'))
    for (const { target } of TARGETS) expect(fs.existsSync(path.join(dir, builtName(target))), target).toBe(true)
    const other = TARGETS.find((t) => t.target !== HOST)!.target
    const r = spawnSync(path.join(dir, builtName(other)), ['--version'], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('rehearsal placeholder')
  })

  it('npm installs the launcher and only this machine\'s package from the registry, and it runs the file', async () => {
    const out = path.join(tmp, 'packs')
    const release = { version: '9.9.9-rehearsal.1', tarballs: packVersion({ files: stub('9.9.9-rehearsal.1'), version: '9.9.9-rehearsal.1', out }) }
    const next = { version: '9.9.9-rehearsal.2', tarballs: packVersion({ files: stub('9.9.9-rehearsal.2'), version: '9.9.9-rehearsal.2', out }) }
    expect(release.tarballs).toHaveLength(TARGETS.length + 1)
    writeFieldJson(out, release, next)
    // Relative to itself: a container mounts the directory elsewhere.
    expect(JSON.parse(fs.readFileSync(path.join(out, 'field.json'), 'utf8')).release.tarballs.every((t: string) => !path.isAbsolute(t))).toBe(true)
    const field = readFieldJson(path.join(out, 'field.json'))
    expect(field.release.tarballs).toEqual(release.tarballs)
    const registry = await startRegistry({ tarballs: [...field.release.tarballs, ...field.next.tarballs].map((file: string) => ({ file })), distTags: { latest: field.release.version }, upstream: 'http://127.0.0.1:9' })
    try {
      const prefix = path.join(tmp, 'prefix')
      const env = { ...process.env, npm_config_prefix: prefix, npm_config_registry: `${registry.url}/`, npm_config_cache: path.join(tmp, 'cache'), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' }
      const code = await new Promise<number>((resolve) => {
        const child = spawn('npm', ['install', '-g', 'open-walnut@latest'], { env, stdio: 'ignore' })
        child.on('close', (c) => resolve(c ?? 1))
      })
      expect(code).toBe(0)
      expect(fs.readdirSync(path.join(prefix, 'lib/node_modules/open-walnut/node_modules/@open-walnut'))).toEqual([HOST])
      const printed = await new Promise<string>((resolve) => {
        const child = spawn(path.join(prefix, 'bin/walnut'), ['--version'], { env })
        let s = ''
        child.stdout.on('data', (d) => { s += d })
        child.on('close', () => resolve(s.trim()))
      })
      expect(printed).toBe('9.9.9-rehearsal.1 (stub)')
    } finally {
      await registry.close()
    }
  }, 180_000)

  it('refuses a field.json whose next release is not newer, or whose tarballs are gone', () => {
    const dir = path.join(tmp, 'bad')
    fs.mkdirSync(dir, { recursive: true })
    const t = path.join(dir, 'a.tgz')
    fs.writeFileSync(t, '')
    fs.writeFileSync(path.join(dir, 'field.json'), JSON.stringify({ release: { version: '1.0.1', tarballs: ['a.tgz'] }, next: { version: '1.0.0', tarballs: ['a.tgz'] } }))
    expect(() => readFieldJson(path.join(dir, 'field.json'))).toThrow('is not newer')
    fs.writeFileSync(path.join(dir, 'field.json'), JSON.stringify({ release: { version: '1.0.1', tarballs: ['gone.tgz'] }, next: { version: '1.0.2', tarballs: ['a.tgz'] } }))
    expect(() => readFieldJson(path.join(dir, 'field.json'))).toThrow('is not there')
  })
})

describe('the field rehearsal refuses what would be unsafe or meaningless', () => {
  it('run.mjs --field latest needs the launcher packages it updates to', () => {
    const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts/release-rehearsal/run.mjs'), '--field', 'latest', '--current', path.join(tmp, 'x.tgz')], { encoding: 'utf8' })
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('pass --field-packs <field.json>')
  })

  it('field-packs.mjs build will not rewrite a git checkout outside CI', () => {
    const env = { ...process.env }
    delete env.CI
    const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts/release-rehearsal/field-packs.mjs'), 'build', '--out', path.join(tmp, 'fb')], { env, encoding: 'utf8' })
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('run it in CI or in a copy of the tree')
  })
})
