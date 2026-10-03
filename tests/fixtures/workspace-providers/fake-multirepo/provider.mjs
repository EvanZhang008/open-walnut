#!/usr/bin/env node
/**
 * A fake multi-repo workspace provider for tests (protocol: docs/reference/workspace-providers.md).
 *
 * It mimics a monorepo tool whose "workspace" is a folder holding several package
 * repositories under `src/`: `create` makes `$HOME/fake-workspaces/<name>/src/<pkg>`,
 * each a clone of a bare "remote" at `$HOME/fake-remotes/<pkg>.git` (so every clone
 * has an upstream and the host-side probe can tell pushed from unpushed work).
 *
 * SAFETY: it only ever writes under $HOME, and refuses to run unless $HOME is inside
 * the system temp folder: a test points HOME at a temp dir it created.
 *
 * Test knobs ride `inputs`: `fail` (reply ok:false), `sleepSec` (sleep before
 * replying), `badJson` (print garbage), `unsafeRoot` (claim a root outside home).
 * Two more sit in files under $HOME, keyed by package, so a browser test can flip
 * them between a failure and its Retry: `fake-provider-fail-<pkg>` (cloning <pkg>
 * fails with the file's text) and `fake-provider-delay-<pkg>` (a pause of that many
 * seconds after the "Cloning <pkg>" line).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = path.resolve(process.env.HOME || '')
const TEMP_ROOTS = [os.tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders']
  .map((p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } })
let homeReal = HOME
try { homeReal = fs.realpathSync(HOME) } catch { /* checked below */ }
if (!HOME || !TEMP_ROOTS.some((t) => homeReal === t || homeReal.startsWith(t + path.sep))) {
  process.stdout.write(JSON.stringify({ version: 1, ok: false, error: `fake provider refuses to run: HOME ${HOME} is not a temp dir` }) + '\n')
  process.exit(0)
}

function reply(obj) {
  process.stdout.write(JSON.stringify({ version: 1, ...obj }) + '\n')
}
function git(args, cwd) {
  const r = spawnSync('git', ['-c', 'user.name=Fake', '-c', 'user.email=fake@example.invalid', '-c', 'init.defaultBranch=main', ...args], {
    cwd, encoding: 'utf8', env: process.env,
  })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`)
  return r.stdout.trim()
}
function sleep(sec) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sec * 1000)
}
function slug(s) {
  return String(s || 'ws').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'ws'
}
function packagesOf(inputs) {
  const raw = inputs?.packages
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : []
  return list.map((p) => slug(p)).filter(Boolean)
}
function ensureRemote(pkg) {
  const remote = path.join(HOME, 'fake-remotes', `${pkg}.git`)
  if (fs.existsSync(remote)) return remote
  const seed = path.join(HOME, 'fake-remotes', `${pkg}-seed`)
  fs.mkdirSync(seed, { recursive: true })
  git(['init', '-q'], seed)
  fs.writeFileSync(path.join(seed, 'README.md'), `# ${pkg}\n`)
  git(['add', '.'], seed)
  git(['commit', '-qm', 'seed'], seed)
  git(['clone', '-q', '--bare', seed, remote], HOME)
  fs.rmSync(seed, { recursive: true, force: true })
  return remote
}
function listRepos(root) {
  const src = path.join(root, 'src')
  if (!fs.existsSync(src)) return []
  return fs.readdirSync(src)
    .sort()
    .filter((n) => fs.existsSync(path.join(src, n, '.git')))
    .map((n) => ({ path: path.join('src', n), name: n }))
}

const raw = fs.readFileSync(0, 'utf8')
let req
try { req = JSON.parse(raw) } catch { reply({ ok: false, error: 'request was not JSON' }); process.exit(0) }
const { operation, arguments: args = {} } = req
const inputs = args.inputs || {}
function knob(kind, pkg) {
  const file = path.join(HOME, `fake-provider-${kind}-${pkg}`)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null
}

try {
  if (inputs.sleepSec) sleep(Number(inputs.sleepSec))
  if (inputs.badJson) { process.stdout.write('this is not json\n'); process.exit(0) }
  if (inputs.fail === operation) { reply({ ok: false, error: `simulated ${operation} failure` }); process.exit(0) }

  if (operation === 'detect') {
    reply({ ok: true, result: args.markerRoot ? { claimed: true, root: args.markerRoot } : { claimed: false, reason: 'no fake-workspace.json marker' } })
  } else if (operation === 'create') {
    const pkgs = packagesOf(inputs)
    if (pkgs.length === 0) { reply({ ok: false, error: 'packages is required (at least one package name)' }); process.exit(0) }
    const root = path.join(HOME, 'fake-workspaces', slug(args.name))
    if (inputs.unsafeRoot) { reply({ ok: true, result: { root: '/', repos: [] } }); process.exit(0) }
    if (fs.existsSync(root)) { reply({ ok: false, error: `${root} already exists` }); process.exit(0) }
    try {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true })
      fs.writeFileSync(path.join(root, 'fake-workspace.json'), JSON.stringify({ packages: pkgs }) + '\n')
      for (const pkg of pkgs) {
        process.stderr.write(`Cloning ${pkg}\n`)
        const delay = Number(knob('delay', pkg)) || 0
        if (delay > 0) sleep(delay)
        const failure = knob('fail', pkg)
        if (failure !== null) throw new Error(failure || `could not clone ${pkg}`)
        git(['clone', '-q', ensureRemote(pkg), path.join(root, 'src', pkg)], HOME)
      }
    } catch (err) {
      // Leave nothing half-made.
      fs.rmSync(root, { recursive: true, force: true })
      throw err
    }
    reply({ ok: true, result: { root, cwd: root, repos: listRepos(root) } })
  } else if (operation === 'listRepos') {
    reply({ ok: true, result: { repos: listRepos(args.root) } })
  } else if (operation === 'status') {
    reply({ ok: false, code: 'unsupported', error: 'status is answered by the host probe' })
  } else if (operation === 'remove') {
    const root = path.resolve(String(args.root || ''))
    if (!root.startsWith(path.join(HOME, 'fake-workspaces') + path.sep)) { reply({ ok: false, error: `refusing to remove ${root}` }); process.exit(0) }
    fs.rmSync(root, { recursive: true, force: true })
    reply({ ok: true, result: { removed: true } })
  } else {
    reply({ ok: false, code: 'unsupported', error: `unknown operation ${operation}` })
  }
} catch (err) {
  reply({ ok: false, error: err instanceof Error ? err.message : String(err) })
}
