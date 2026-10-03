/**
 * Session commit ('git-commit-v1') is wired the same way in both daemon twins:
 * the bun binary imports git-commit-core.ts + git-attribution-core.ts, the JS
 * source twin inlines their factories as text. This pins the wiring (commands,
 * capability, bridge exclusion, version/build lists) and runs the INLINED text
 * against a real temp repo, so a factory that grew a module-scope reference
 * fails here instead of on a remote host.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn, execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vm from 'node:vm'
import { createGitAttribution } from '../../src/providers/git-attribution-core.js'
import { createGitCommitCore, type GitCommitDeps } from '../../src/providers/git-commit-core.js'
import { ADVERTISED_DAEMON_CAPABILITIES, REQUIRED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const standalone = read('src/providers/daemon-standalone.ts')
const source = read('src/providers/daemon-source.ts')
const COMMANDS = ['git.commitPlan', 'git.commitStart', 'git.commitJob']

function bridgeAllowlist(src: string): string {
  const start = src.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set([')
  expect(start).toBeGreaterThan(0)
  const end = src.indexOf('])', start)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('git-commit-v1 twin wiring', () => {
  it('both twins dispatch the three commands', () => {
    for (const src of [standalone, source]) {
      for (const cmd of COMMANDS) expect(src).toContain(`case '${cmd}':`)
    }
  })

  it('the capability is advertised, not required, and no command is reachable over the bridge', () => {
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('git-commit-v1')
    expect(REQUIRED_DAEMON_CAPABILITIES as readonly string[]).not.toContain('git-commit-v1')
    for (const src of [standalone, source]) {
      const allow = bridgeAllowlist(src)
      for (const cmd of COMMANDS) expect(allow).not.toContain(cmd)
    }
  })

  it('the core files are in the version hash list and the binary build list, in the same order', () => {
    const files = ['src/providers/git-attribution-core.ts', 'src/providers/git-commit-core.ts']
    const versionList = read('src/providers/daemon-version-check.ts')
    const build = read('scripts/build-daemon.sh')
    for (const f of files) {
      expect(versionList).toContain(`'${f}'`)
      expect(build).toContain(f)
    }
    expect(versionList.indexOf(files[0])).toBeLessThan(versionList.indexOf(files[1]))
    expect(build.indexOf(files[0])).toBeLessThan(build.indexOf(files[1]))
  })

  it('the source twin inlines both factories exactly once and still parses', () => {
    // The template uses each placeholder once (getDaemonSource throws otherwise);
    // the injection table and the deploy-time smoke name them too.
    expect(source).toContain("['__CREATE_GIT_COMMIT__', createGitCommitCore.toString()]")
    expect(source).toContain("['__CREATE_GIT_ATTRIBUTION__', createGitAttribution.toString()]")
    expect(source).toContain('const gitCommit = (__CREATE_GIT_COMMIT__)({')
    expect(source).toContain('attribution: (__CREATE_GIT_ATTRIBUTION__)(),')
    const out = getDaemonSource()
    expect(out).not.toContain('__CREATE_GIT_COMMIT__')
    expect(out).not.toContain('__CREATE_GIT_ATTRIBUTION__')
    expect(out).toContain('git.commitPlan')
    expect(() => new vm.Script(out, { filename: 'daemon-source.js' })).not.toThrow()
  })
})

describe('the inlined factories commit like the imported ones', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-git-commit-twin-')))
  afterAll(() => { if (tmp.includes('walnut-git-commit-twin-')) fs.rmSync(tmp, { recursive: true, force: true }) })
  const gitconfig = path.join(tmp, 'gitconfig')
  fs.writeFileSync(gitconfig, '[user]\n\tname = Twin\n\temail = twin@example.com\n')
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmp, TMPDIR: tmp, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' }

  function makeRepo(name: string): string {
    const dir = path.join(tmp, name)
    fs.mkdirSync(dir)
    const git = (args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'pipe' })
    git(['init', '-q', '-b', 'main'])
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nb\nc\nd\ne\nf\ng\nh\n')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'init'])
    fs.writeFileSync(path.join(dir, 'f.txt'), 'A\nb\nc\nd\ne\nf\ng\nH\n')
    return dir
  }

  async function commitWith(factories: { attr: typeof createGitAttribution; commit: typeof createGitCommitCore }, dir: string) {
    const c = factories.commit({
      spawn: ((cmd: string, args: string[], o: Record<string, unknown>) => {
        if (!String(o.cwd).startsWith(tmp)) throw new Error('spawn outside the temp dir')
        return spawn(cmd, args, o)
      }) as unknown as GitCommitDeps['spawn'],
      fs: fs as unknown as GitCommitDeps['fs'], path, tmpdir: () => tmp, env, attribution: factories.attr(),
    })
    const plan = await c.plan({}, {
      groups: [{ repoRoot: dir, files: [{ filePath: path.join(dir, 'f.txt'), relPath: 'f.txt', status: 'modified' }] }],
      fileMap: new Map([[path.join(dir, 'f.txt'), { ops: [{ kind: 'edit' as const, oldString: 'a\n', newString: 'A\n', replaceAll: false }] }]]),
    })
    const repo = plan.repos[0]
    const hunks = repo.files[0].hunks!
    const started = c.start({
      action: 'commit', repoRoot: dir, branch: 'main', expectedHead: repo.headSha, message: 'twin',
      selections: [{ path: 'f.txt', mode: 'hunks', hunks: hunks.filter((h) => h.owner === 'mine') }],
    })
    await started.done
    const job = c.job(started.job.id)!
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded')
    return { owners: hunks.map((h) => h.owner), blob: execFileSync('git', ['show', 'HEAD:f.txt'], { cwd: dir, env, encoding: 'utf8' }) }
  }

  it('produces the same hunks and the same committed blob', async () => {
    const strict = (fn: { toString(): string }) => new Function('"use strict"; return (' + fn.toString() + ')')()
    const inlined = { attr: strict(createGitAttribution), commit: strict(createGitCommitCore) }
    const imported = await commitWith({ attr: createGitAttribution, commit: createGitCommitCore }, makeRepo('imported'))
    const fromText = await commitWith(inlined, makeRepo('inlined'))
    expect(imported).toEqual({ owners: ['mine', 'other'], blob: 'A\nb\nc\nd\ne\nf\ng\nh\n' })
    expect(fromText).toEqual(imported)
  }, 60_000)
})
