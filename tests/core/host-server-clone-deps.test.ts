/**
 * When a clone build of a host's walnut file may link the checkout's node_modules
 * (src/core/host-server/clone-deps.ts), and that its rules are the deploy's: each
 * fixture is judged by clone-deps.ts AND by the very check scripts/deploy-committed.sh
 * runs (its heredoc, run with node), and both must say the same. 2026-11-11: the deploy
 * installed the commit's own codex-acp patch while the clone build linked the checkout's
 * older one, so the Intel Mac file's daemon version differed and every update was refused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { daemonVersionAt, patchHunks, patchIsStale, staleDependencies } from '../../src/core/host-server/clone-deps.js'
import { computeExpectedDaemonVersion, DAEMON_SOURCE_FILES } from '../../src/providers/daemon-version-check.js'

let dir = ''
let checkout = ''
let tree = ''

function write(root: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}

const PATCH = [
  'diff --git a/index.js b/index.js', '--- a/index.js', '+++ b/index.js', '@@ -1,2 +1,3 @@', ' base', '+patched line two', ' tail', '',
].join('\n')

/** The commit: a dependency, a patched one, a workspace package, a web app with one dependency. */
function commit(pkg: Record<string, unknown> = {}): void {
  write(tree, 'package.json', JSON.stringify({
    name: 'open-walnut', workspaces: ['packages/api'],
    dependencies: { dep: '1.0.0', leftpad: '1.0.0', '@open-walnut/api': 'workspace:*' },
    devDependencies: { '@scope/tool': '2.0.0' },
    patchedDependencies: { 'leftpad@1.0.0': 'patches/leftpad@1.0.0.patch' },
    ...pkg,
  }))
  write(tree, 'packages/api/package.json', JSON.stringify({ name: '@open-walnut/api' }))
  write(tree, 'patches/leftpad@1.0.0.patch', PATCH)
  write(tree, 'web/package.json', JSON.stringify({ name: 'web', dependencies: { vite: '7.0.0' } }))
}

/** The checkout's install of it: everything there, the patch applied. */
function installed(opts: { leftpad?: string } = {}): void {
  write(checkout, 'package.json', JSON.stringify({ name: 'open-walnut', patchedDependencies: { 'leftpad@1.0.0': 'patches/leftpad@1.0.0.patch' } }))
  write(checkout, 'node_modules/dep/package.json', '{}')
  write(checkout, 'node_modules/leftpad/package.json', '{}')
  write(checkout, 'node_modules/leftpad/index.js', opts.leftpad ?? 'base\npatched line two\ntail\n')
  write(checkout, 'node_modules/@scope/tool/package.json', '{}')
  write(checkout, 'web/node_modules/vite/package.json', '{}')
}

/** What deploy-committed.sh's own dependency check prints for the same trees. */
function deployVerdict(): string[] {
  const script = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'deploy-committed.sh'), 'utf8')
  const start = script.indexOf('missing="$(cd "$BUILD" && "${JS_RUN[@]}" "$deps_src/node_modules" "$BUILD/node_modules" "$BUILD" "$SERVE_ROOT" <<\'JS\'\n')
  expect(start, 'the deploy\'s dependency check moved: update this test to read it').toBeGreaterThan(0)
  const body = script.slice(script.indexOf('\n', start) + 1, script.indexOf('\nJS\n', start))
  const file = path.join(dir, 'deploy-check.cjs')
  fs.writeFileSync(file, body)
  // Its first half links the checkout's entries into the clone's node_modules: a scratch dir here.
  const dst = path.join(dir, 'deploy-links')
  const r = spawnSync('node', [file, path.join(checkout, 'node_modules'), dst, tree, checkout], { encoding: 'utf8' })
  expect(r.status, r.stderr).toBe(0)
  return r.stdout.split('\n').filter(Boolean)
}

async function judged(): Promise<string[]> {
  const ours = await staleDependencies(checkout, tree)
  expect(ours).toEqual(deployVerdict())
  return ours
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clone-deps-')))
  checkout = path.join(dir, 'checkout')
  tree = path.join(dir, 'tree')
  commit()
  installed()
})

afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('staleDependencies (the deploy\'s rules)', () => {
  it('an install of this commit can be linked', async () => {
    expect(await judged()).toEqual([])
  })

  it('a dependency the commit adds that the checkout has not installed', async () => {
    commit({ dependencies: { dep: '1.0.0', leftpad: '1.0.0', added: '1.0.0', '@open-walnut/api': 'workspace:*' } })
    expect(await judged()).toEqual(['root added'])
  })

  it('a web dependency the checkout lacks', async () => {
    write(tree, 'web/package.json', JSON.stringify({ name: 'web', dependencies: { vite: '7.0.0', react: '19.0.0' } }))
    expect(await judged()).toEqual(['web react'])
  })

  it('a patched dependency installed with an older patch (the 11-11 codex-acp case)', async () => {
    installed({ leftpad: 'base\ntail\n' })
    expect(await judged()).toEqual(['root patched leftpad'])
  })

  it('a patch the commit dropped while the checkout keeps it applied', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(tree, 'package.json'), 'utf8'))
    delete pkg.patchedDependencies
    write(tree, 'package.json', JSON.stringify(pkg))
    expect(await judged()).toEqual(['root unpatched leftpad'])
  })

  it('a scoped package patched by version, installed without it', async () => {
    commit({ patchedDependencies: { '@scope/tool@2.0.0': 'patches/tool.patch' } })
    write(tree, 'patches/tool.patch', PATCH)
    write(checkout, 'package.json', JSON.stringify({ name: 'open-walnut', patchedDependencies: { '@scope/tool@2.0.0': 'patches/tool.patch' } }))
    write(checkout, 'node_modules/@scope/tool/index.js', 'base\ntail\n')
    expect(await judged()).toEqual(['root patched @scope/tool'])
  })

  it('a workspace package is never asked of the checkout', async () => {
    expect(fs.existsSync(path.join(checkout, 'node_modules', '@open-walnut', 'api'))).toBe(false)
    expect(await judged()).toEqual([])
  })

  it('a workspace package web/ declares is never asked of the checkout either', async () => {
    write(tree, 'web/package.json', JSON.stringify({ name: 'web', dependencies: { vite: '7.0.0', '@open-walnut/api': 'workspace:*' } }))
    expect(await judged()).toEqual([])
  })

  it('reads only: neither tree changes', async () => {
    installed({ leftpad: 'base\ntail\n' })
    const list = (root: string) => spawnSync('find', [root], { encoding: 'utf8' }).stdout.split('\n').sort()
    const before = [list(checkout), list(tree)]
    await staleDependencies(checkout, tree)
    expect([list(checkout), list(tree)]).toEqual(before)
  })
})

describe('patch hunks', () => {
  it('a hunk reads as applied: its context and added lines in order', () => {
    expect(patchHunks(PATCH)).toEqual([{ name: 'index.js', hunks: [['base', 'patched line two', 'tail', '']] }])
  })

  it('a file of the patch that is missing counts as stale', async () => {
    fs.rmSync(path.join(checkout, 'node_modules', 'leftpad', 'index.js'))
    expect(await patchIsStale(path.join(checkout, 'node_modules', 'leftpad'), PATCH)).toBe(true)
  })
})

describe('daemonVersionAt', () => {
  it('hashes a tree the way the server computes its own daemon version', async () => {
    const root = path.join(__dirname, '..', '..')
    expect(await daemonVersionAt(root, DAEMON_SOURCE_FILES)).toBe(computeExpectedDaemonVersion())
  })

  it('a file that is missing gives no version', async () => {
    expect(await daemonVersionAt(tree, ['no/such/file.ts'])).toBeNull()
  })
})
