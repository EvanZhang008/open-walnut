/**
 * Ratchet: nothing starts Walnut's own code under Node or tsx. Walnut runs on
 * bun alone; Node remains only where a user or a tool brings it.
 *
 * Scanned: package.json scripts, the Playwright configs, every workflow's run
 * lines, the shell scripts in scripts/ and desktop/, the JS/TS launchers in
 * scripts/ and bin/ (a spawn of node or tsx, a `#!/usr/bin/env node`), and the
 * Mac app's Swift. A start is `node <x>` or `tsx <x>` where a command starts
 * (a probe like `node --version` starts nothing), `npx tsx`, `--import tsx`,
 * or a spawn naming node or tsx.
 *
 * GENUINE lists the starts that need Node, each with its reason: a user's own
 * Node (npm runs postinstall; a job that is a user's machine), or a tool that
 * needs it (the Node archive's builder, for the releases it is still built
 * for). Any other start fails here; so does an entry that matches nothing, so
 * the list never outlives what it allows. Entries match by file and a piece of
 * the line. The list is that of the tree with the bun-only runtime, dev and
 * docs changes in.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../..')

interface Entry { file: string; match: string; why: string }

const GENUINE: Entry[] = [
  { file: 'package.json', match: 'postinstall: node scripts/postinstall.mjs', why: 'npm runs a package\'s postinstall on the user\'s Node; the script tells an npm user to use bun' },
  { file: 'scripts/postinstall.mjs', match: '#!/usr/bin/env node', why: 'the runtime package.json\'s postinstall runs it with: npm runs it on the user\'s Node' },
  { file: 'scripts/build-sqlite-dylib.mjs', match: '#!/usr/bin/env node', why: 'postinstall starts it on its own runtime, the user\'s Node under npm; a direct run matches that' },
  { file: '.github/workflows/ci.yml', match: 'node scripts/npm-registry-lag.mjs npm install -g open-walnut', why: 'the onboarding job is a user\'s machine with Node and npm; the wrapper retries their npm install' },
  { file: '.github/workflows/release.yml', match: 'node "$GITHUB_WORKSPACE/scripts/npm-registry-lag.mjs" npm install -g', why: 'a user\'s npm install, on their Node, retried while npm catches up with a publish' },
  { file: 'desktop/AppBuiltCheckout.swift', match: 'exe == "node"', why: 'recognizes the process of a checkout an older app started; starts nothing' },
  { file: 'desktop/BundledRuntime.swift', match: 'var node: String', why: 'the path of the Node an archive install (before the compiled file) carries; starts nothing' },
  { file: 'scripts/onboarding-test/remote-host/fixture/claude-cli.js', match: '#!/usr/bin/env node', why: 'a stand-in claude CLI inside the remote host container, which is a user\'s host with its own Node' },
  // The Node archive (release-archives.yml, for the two releases it is still built
  // for): a published version installed with npm on that version's own Node.
  { file: 'scripts/runtime-bundle/build.mjs', match: '#!/usr/bin/env node', why: 'the Node archive\'s builder' },
  { file: '.github/workflows/release-archives.yml', match: 'node scripts/runtime-bundle/build.mjs --check', why: 'the Node archive\'s builder' },
  { file: '.github/workflows/release-archives.yml', match: 'node scripts/runtime-bundle/build.mjs --spec', why: 'the Node archive\'s builder' },
  { file: 'scripts/release-rehearsal/runtime.mjs', match: "spawn('node', [BUILD, ...args], opts)", why: 'the rehearsal (CI jobs rehearsal and archive-targets) runs the Node archive\'s builder on Node, as release-archives.yml does' },
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

  it('every start is a genuine one', () => {
    const unlisted = found.filter((s) => !listed(GENUINE, s)).map((s) => `${s.at}: ${s.text}`)
    expect(unlisted, 'run it with bun (`bun <script>`, `bun -p`, `bun run <script>`); a start that needs Node goes in GENUINE with its reason').toEqual([])
  })

  it('every genuine entry still allows a start', () => {
    const unused = GENUINE.filter((e) => !found.some((s) => s.file === e.file && s.text.includes(e.match))).map((e) => `${e.file}: ${e.match}`)
    expect(unused, 'a start that moved to bun leaves its entry behind: delete it').toEqual([])
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
