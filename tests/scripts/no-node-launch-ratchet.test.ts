/**
 * Ratchet: nothing starts Walnut's own code under Node or tsx. Walnut runs on
 * bun alone (one runtime; Node remains only where a user or a tool brings it).
 *
 * Scanned: package.json scripts, the Playwright configs, every workflow's run
 * lines, the shell scripts in scripts/ and desktop/, the JS/TS launchers in
 * scripts/ and bin/ (a spawn of node or tsx, a `#!/usr/bin/env node`), and the
 * Mac app's Swift. A start is `node <x>` or `tsx <x>` where a command starts
 * (a probe like `node --version` starts nothing), `npx tsx`, `--import tsx`,
 * or a spawn naming node or tsx.
 *
 * GENUINE lists the starts that need Node, each with its reason: the user's own
 * Node (npm runs postinstall; the npm channel's jobs have no bun by design) or a
 * tool's. LEFT lists the starts still to move to bun, each with the part of the
 * tree it belongs to; move one and delete its entry. A start in neither list
 * fails here. Entries match by file and a piece of the line, so they keep
 * matching while the files around them change; an entry that matches nothing
 * any more does not fail (it is printed), so the lists can serve trees that
 * have moved different parts. The lists are those of the tree with the bun-only
 * runtime, dev and docs changes in; without them their starts fail here.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../..')

interface Entry { file: string; match: string; why: string }

const GENUINE: Entry[] = [
  { file: 'package.json', match: 'postinstall: node scripts/postinstall.mjs', why: 'npm runs a package\'s postinstall on the user\'s Node; the script tells an npm user to use bun' },
  { file: '.github/workflows/ci.yml', match: 'node scripts/npm-registry-lag.mjs npm install -g open-walnut', why: 'the onboarding job is a user\'s machine with Node and npm; the wrapper retries their npm install' },
  { file: '.github/workflows/release.yml', match: 'node "$GITHUB_WORKSPACE/scripts/npm-registry-lag.mjs" npm install -g', why: 'a user\'s npm install, on their Node, retried while npm catches up with a publish' },
  { file: 'desktop/AppBuiltCheckout.swift', match: 'exe == "node"', why: 'recognizes the process of a checkout an older app started; starts nothing' },
  { file: 'desktop/BundledRuntime.swift', match: 'var node: String', why: 'the path of the Node an archive install (before the compiled file) carries; starts nothing' },
  { file: 'scripts/onboarding-test/remote-host/fixture/claude-cli.js', match: '#!/usr/bin/env node', why: 'a stand-in claude CLI inside the remote host container, which is a user\'s host with its own Node' },
]

const LEFT: Entry[] = [
  // The release pipeline and its npm channel jobs: Walnut's release scripts, run with node.
  ...['scripts/release-files.mjs stamp'].map((match) => ({ file: '.github/workflows/binary-matrix.yml', match, why: 'release: the binary matrix stamps with node' })),
  ...['node scripts/check-publish.mjs', 'node scripts/release-rehearsal/pack.mjs', 'node scripts/release-rehearsal/run.mjs', 'node -p "require(process.argv[1]).current"', 'node scripts/runtime-bundle/build.mjs']
    .map((match) => ({ file: '.github/workflows/ci.yml', match, why: 'the npm channel jobs (rehearsal, archive-targets) rehearse release.yml\'s own steps, so they move with it' })),
  ...['scripts/desktop-smoke.mjs', 'scripts/homebrew/cask.mjs'].map((match) => ({ file: '.github/workflows/mac-app.yml', match, why: 'release: the Mac app workflow' })),
  ...['scripts/runtime-bundle/build.mjs', 'scripts/release-rehearsal/run.mjs', 'scripts/homebrew/formula.mjs'].map((match) => ({ file: '.github/workflows/release-archives.yml', match, why: 'release: the Node archives (to be removed)' })),
  ...['node -p "require(\'./package.json\').version"', 'scripts/ci-gate.mjs', 'scripts/release-build.mjs', 'scripts/npm-packages.mjs', 'scripts/release-notes.mjs', 'scripts/nightly-version.mjs', 'scripts/stable-promote.mjs']
    .map((match) => ({ file: '.github/workflows/release.yml', match, why: 'release: the release workflow runs its scripts with node' })),
  { file: '.github/workflows/star-history.yml', match: 'node scripts/generate-star-history.mjs', why: 'a repo chore workflow' },
  { file: 'desktop/build-release.sh', match: 'scripts/desktop-carry-release.mjs', why: 'release: the Mac app build carries the release with node' },
  ...['scripts/ios-perf-check.sh', 'scripts/ios-perf/freeze-probe.sh', 'scripts/ios-perf/kb-loop-probe.sh'].map((file) => ({ file, match: 'node "', why: 'iOS perf probes: their mock server and fixture maker run with node' })),
  { file: 'scripts/robot-user/robot.sh', match: 'node "$HERE/episode.mjs"', why: 'the robot user soak test' },
  // Shebangs: run by path, these start on Node.
  ...['scripts/ci-gate.mjs', 'scripts/demo-full-flow.mjs', 'scripts/demo-ssh-autodiscovery.mjs',
    'scripts/robot-user/actions.mjs', 'scripts/robot-user/brain.mjs', 'scripts/robot-user/episode.mjs', 'scripts/robot-user/maestro-driver.mjs', 'scripts/robot-user/oracles.mjs',
    'scripts/runtime-bundle/build.mjs', 'scripts/verify-fork-popover.mjs', 'scripts/verify-session-split-views.mjs']
    .map((file) => ({ file, match: '#!/usr/bin/env node', why: 'a script that starts on Node when run by its path' })),
]

/** A start of node, tsx or ts-node at a shell command position (not a version probe). */
const SHELL_START = /(?:^|[;&|(]\s*|\$\(\s*|`\s*|\b(?:exec|then|do|else|nohup|time)\s+)(?:\w+=\S*\s+)*(?:"?\$?[\w{}./-]*"?\/)?(node|tsx|ts-node)"?(?=\s|$)(?!\s+(?:--version|-v)\b)/
const TSX_LOADER = /\bnpx\s+(?:-y\s+)?(?:tsx|ts-node)\b|--(?:import|loader)[= ]tsx\b|['"]--(?:import|loader)['"]\s*,\s*['"]tsx['"]/
const JS_SPAWN = /\b(?:spawn|spawnSync|execFile|execFileSync|fork|exec|execSync)\(\s*['"`](?:node|tsx)['"` ]|\bBun\.spawn(?:Sync)?\(\s*\[\s*['"](?:node|tsx)['"]/
const SHEBANG_NODE = /^#!.*\b(?:node|tsx)\b/

const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join('/')
function walk(dir: string, keep: (name: string) => boolean): string[] {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return []
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return []
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p, keep) : keep(e.name) ? [p] : []
  })
}

/** Every start found: `file`, the line as matched against the entries, and where. */
function starts(): Array<{ file: string; text: string; at: string }> {
  const found: Array<{ file: string; text: string; at: string }> = []
  const scripts = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
  for (const [name, cmd] of Object.entries(scripts)) {
    for (const part of cmd.split(/&&|\|\||;|\|/)) {
      if (SHELL_START.test(part.trim()) || TSX_LOADER.test(part)) found.push({ file: 'package.json', text: `${name}: ${part.trim()}`, at: `package.json "${name}"` })
    }
  }
  const lines = (file: string, test: (line: string, n: number) => boolean, comment: RegExp) => {
    fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').forEach((line, i) => {
      const t = line.trim()
      if (i > 0 && comment.test(t)) return
      if (test(t, i)) found.push({ file: rel(path.join(ROOT, file)), text: t, at: `${file}:${i + 1}` })
    })
  }
  const shell = (t: string) => !/^(?:echo|printf|log|warn|die|fail|info)\b/.test(t) && (SHELL_START.test(t) || TSX_LOADER.test(t))
  // A step's one-line `run: node x` starts where its value does.
  for (const f of walk('.github/workflows', (n) => /\.ya?ml$/.test(n))) lines(f, (t) => shell(t.replace(/^(?:-\s+)?run:\s*/, '')), /^#/)
  for (const f of [...walk('scripts', (n) => n.endsWith('.sh')), ...walk('desktop', (n) => n.endsWith('.sh'))]) lines(f, (t, i) => (i === 0 ? SHEBANG_NODE.test(t) : shell(t)), /^#/)
  for (const f of [...walk('scripts', (n) => /\.(?:mjs|cjs|js|ts|mts)$/.test(n)), ...walk('bin', () => true)]) {
    lines(f, (t, i) => (i === 0 && SHEBANG_NODE.test(t)) || JS_SPAWN.test(t) || TSX_LOADER.test(t), /^(?:\/\/|\*|\/\*)/)
  }
  for (const f of ['playwright.config.ts', ...walk('tests/e2e/browser', (n) => n.endsWith('.config.ts'))]) {
    if (fs.existsSync(path.join(ROOT, f))) lines(f, (t) => TSX_LOADER.test(t) || /\btsx\b\s+\S|['"`]node\s/.test(t), /^(?:\/\/|\*|\/\*)/)
  }
  for (const f of walk('desktop', (n) => n.endsWith('.swift'))) lines(f, (t) => /"(?:node|tsx)"|\/node"|\bnpx\b/.test(t), /^\/\//)
  return found
}

const listed = (list: Entry[], s: { file: string; text: string }) => list.find((e) => e.file === s.file && s.text.includes(e.match))

describe('nothing starts Walnut\'s own code under Node or tsx', () => {
  const found = starts()

  it('every start is a genuine one or one listed to move', () => {
    const unlisted = found.filter((s) => !listed(GENUINE, s) && !listed(LEFT, s)).map((s) => `${s.at}: ${s.text}`)
    expect(unlisted, 'run it with bun (or `bun run <script>`); a genuine Node start goes in GENUINE with its reason').toEqual([])
  })

  it('reports what is still to move', () => {
    const left = found.filter((s) => !listed(GENUINE, s) && listed(LEFT, s))
    const unused = [...GENUINE, ...LEFT].filter((e) => !found.some((s) => s.file === e.file && s.text.includes(e.match)))
    // eslint-disable-next-line no-console
    console.log(`[no-node-launch] ${left.length} start(s) still to move:\n${left.map((s) => `  ${s.at}: ${s.text.slice(0, 120)}`).join('\n')}` +
      (unused.length ? `\n[no-node-launch] entries that match nothing here: ${unused.map((e) => `${e.file} (${e.match})`).join(', ')}` : ''))
    expect(found.length).toBeGreaterThan(0)
  })

  it('finds each kind of start, and no version probe or word list', () => {
    for (const t of ['node scripts/x.mjs', 'FOO=1 node dist/cli.js', 'exec node "$x"', 'out="$(node scripts/a.mjs)"', 'tsx src/cli.ts', '"$DIR"/node x.js', 'a && node b.mjs'])
      expect(SHELL_START.test(t), t).toBe(true)
    for (const t of ['node --version', 'node -v 2>/dev/null', 'for tool in node npm npx; do', 'bun scripts/x.mjs', 'command -v node', 'node_modules/.bin/vite', 'uses: actions/setup-node@v5'])
      expect(SHELL_START.test(t), t).toBe(false)
    expect(TSX_LOADER.test('npx tsx scripts/a.ts')).toBe(true)
    expect(TSX_LOADER.test("spawn(process.execPath, ['--import', 'tsx', file])")).toBe(true)
    expect(JS_SPAWN.test("spawnSync('node', [script])")).toBe(true)
    expect(JS_SPAWN.test('execSync(`node ${file}`)')).toBe(true)
    expect(JS_SPAWN.test('spawn(process.execPath, [script])')).toBe(false)
    expect(SHEBANG_NODE.test('#!/usr/bin/env node')).toBe(true)
    expect(SHEBANG_NODE.test('#!/usr/bin/env bun')).toBe(false)
  })
})
