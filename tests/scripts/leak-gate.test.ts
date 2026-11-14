/**
 * The leak gate of the public repository (scripts/leak-scan/scan-git.mjs and the hooks, land
 * and CI that run it). One fixture per kind of private content, and each must be blocked at
 * every path a change takes to GitHub: the pre-commit hook, the commit-msg hook, the pre-push
 * scan, the land's range scan, CI's history scan and the write-time guard (--text). Every word
 * here is invented (the real rules are private and never in this repo), and every credential is
 * built at run time, so this file itself holds none.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { compileRules, decodeRules, loadRules, scanText } from '../../scripts/leak-scan/core.mjs'
import { parseSource } from '../../scripts/leak-scan/build-rules.mjs'
import { lineParser, unquote } from '../../scripts/leak-scan/scan-git.mjs'

const REPO = path.join(import.meta.dirname, '..', '..')
const LEAK_DIR = path.join(REPO, 'scripts', 'leak-scan')
const HAS_GITLEAKS = spawnSync('gitleaks', ['version']).status === 0

// The private rules of this test: invented words standing for each kind the real rules hold.
const PRIVATE_TSV = [
  'work-email\tregex\t(?<=[a-z0-9._%+-])@acmecorp\\.example\\b',
  'internal-host\tregex\t\\bwiki\\.acmecorp\\.example\\b',
  'internal-tool\tterm\tzorblatt',
  'work-username\tterm\tjqpublic',
  'personal-phone\tterm\t555 010 4477',
  'personal-address\tterm\t742 evergreen',
  'private-host\tterm\tmarina-mbp',
  'internal-tool-word\tterm@source\tquibbleton',
].join('\n')

/** Random letters and digits (a credential's body), never one an allow pattern names. */
function token(n: number): string {
  for (;;) {
    const t = randomBytes(n * 2).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, n)
    if (t.length === n && !/fake|example|placeholder|0123456789|abcdef|test/i.test(t)) return t
  }
}

interface Fixture { kind: string; file: string; content: string | Buffer; text: boolean; label: RegExp }
const FIXTURES: Fixture[] = [
  { kind: 'credential (a committed shape)', file: 'src/keys.ts', content: `export const key = '${'AB' + 'SK'}${token(56)}'\n`, text: true, label: /bedrock-api-key/ },
  { kind: 'employer email', file: 'docs/contact.md', content: 'Ask pat@acmecorp.example for access.\n', text: true, label: /work-email/ },
  { kind: 'internal URL and host', file: 'docs/links.md', content: 'See https://wiki.acmecorp.example/team for the runbook.\n', text: true, label: /internal-host/ },
  { kind: 'internal name', file: 'src/deploy.ts', content: '// deploys through zorblatt\nexport const x = 1\n', text: true, label: /internal-tool/ },
  { kind: 'internal name, source-only rule', file: 'src/word.ts', content: '// the quibbleton pipeline\n', text: true, label: /internal-tool-word/ },
  { kind: 'personal home path', file: 'tests/paths.test.ts', content: "const p = '/Users/jqpublic/notes/a.md'\n", text: true, label: /work-username/ },
  { kind: 'phone number', file: 'docs/me.md', content: 'Call 555-010-4477 after six.\n', text: true, label: /personal-phone/ },
  { kind: 'home address', file: 'docs/where.md', content: 'Ship it to 742 Evergreen, please.\n', text: true, label: /personal-address/ },
  { kind: 'private hostname', file: 'docs/hosts.md', content: 'ssh marina-mbp.local\n', text: true, label: /private-host/ },
  { kind: 'a letter from the private data store', file: 'notes/.open-walnut/human-inbox/letter.md', content: 'Dear owner,\n', text: false, label: /private-data-file/ },
  { kind: 'a session transcript', file: 'data/session-a1.jsonl', content: '{"type":"user","message":"hi"}\n', text: false, label: /private-data-file/ },
  { kind: 'a screenshot outside the asset folders', file: 'Screenshot 1.png', content: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), text: false, label: /media-outside-assets/ },
]

let root: string
let rulesFile: string
let env: NodeJS.ProcessEnv

function sh(cmd: string, args: string[], cwd: string, extra: { input?: string; env?: NodeJS.ProcessEnv } = {}): SpawnSyncReturns<string> {
  return spawnSync(cmd, args, { cwd, env: { ...env, ...extra.env }, input: extra.input ?? '', encoding: 'utf8', maxBuffer: 1 << 26 })
}
function git(cwd: string, ...args: string[]): string {
  const r = sh('git', args, cwd)
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const out = (r: SpawnSyncReturns<string>) => `${r.stdout}\n${r.stderr}`

/** A repository holding the committed scanner and hooks, with this test's private rules. */
function scratchRepo(name: string): string {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@example.invalid')
  git(dir, 'config', 'user.name', 'T')
  git(dir, 'config', 'core.hooksPath', '/dev/null')
  git(dir, 'config', 'walnut.leakRules', rulesFile)
  fs.cpSync(LEAK_DIR, path.join(dir, 'scripts', 'leak-scan'), { recursive: true })
  fs.cpSync(path.join(REPO, '.husky', 'pre-commit'), path.join(dir, '.husky', 'pre-commit'))
  fs.cpSync(path.join(REPO, '.husky', 'commit-msg'), path.join(dir, '.husky', 'commit-msg'))
  fs.writeFileSync(path.join(dir, 'README.md'), 'a scratch repository\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base')
  return dir
}
function put(dir: string, f: Fixture) {
  fs.mkdirSync(path.dirname(path.join(dir, f.file)), { recursive: true })
  fs.writeFileSync(path.join(dir, f.file), f.content)
}
/** The place a hit must name: file and line for text, the file for a file rule. */
const place = (f: Fixture) => (f.text ? `${f.file}:1` : f.file)

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-gate-'))
  const home = path.join(root, 'home')
  fs.mkdirSync(home)
  fs.writeFileSync(path.join(root, 'gitconfig'), '')
  env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  delete env.WALNUT_LEAK_STRICT
  rulesFile = path.join(root, 'rules.json')
  fs.writeFileSync(rulesFile, JSON.stringify(compileRules(parseSource(PRIVATE_TSV), { seed: 7 })))
})
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe('every kind of private content is blocked at every path to GitHub', () => {
  for (const f of FIXTURES) {
    it(`${f.kind}: pre-commit, pre-push, land, CI history and the write guard all block it, naming the place`, () => {
      const dir = scratchRepo(`r-${FIXTURES.indexOf(f)}`)
      const base = git(dir, 'rev-parse', 'HEAD')
      put(dir, f)
      git(dir, 'add', '-A')

      // the pre-commit hook, as git runs it (cwd = the top of the repository)
      const pre = sh('sh', ['.husky/pre-commit'], dir)
      expect(pre.status, out(pre)).toBe(1)
      expect(out(pre)).toMatch(f.label)
      expect(out(pre)).toContain(place(f))

      git(dir, 'commit', '-qm', 'add the fixture')
      const tip = git(dir, 'rev-parse', 'HEAD')

      // the pre-push scan, with the refs a pre-push hook reads
      const bare = path.join(root, `bare-${FIXTURES.indexOf(f)}.git`)
      git(root, 'init', '-q', '--bare', bare)
      git(dir, 'push', '-q', bare, `${base}:refs/heads/main`)
      const push = sh('bash', ['scripts/leak-scan/scan-push.sh', 'origin', bare], dir, { input: `refs/heads/main ${tip} refs/heads/main ${base}\n` })
      expect(push.status, out(push)).toBe(1)
      expect(out(push)).toMatch(f.label)
      expect(out(push)).toContain(place(f))

      // the land: every commit of the range
      const land = sh('bun', ['scripts/leak-scan/scan-git.mjs', '--range', `${base}..${tip}`], dir)
      expect(land.status, out(land)).toBe(1)
      expect(out(land)).toContain(`${place(f)} (commit ${tip.slice(0, 10)})`)

      // CI: the whole history, rules from the secret, output redacted (never the text)
      const ci = sh('bun', ['scripts/leak-scan/scan-git.mjs', '--history', 'HEAD', '--redact', '--rules-env', 'LEAK_TEST_RULES'], dir, {
        env: { LEAK_TEST_RULES: Buffer.from(fs.readFileSync(rulesFile)).toString('base64') },
      })
      expect(ci.status, out(ci)).toBe(1)
      expect(out(ci)).toMatch(f.label)
      if (f.text) expect(out(ci)).not.toContain(String(f.content).trim())

      // the write-time guard of an agent's edit
      if (f.text) {
        const w = sh('bun', ['scripts/leak-scan/scan-git.mjs', '--text', f.file], dir, { input: String(f.content) })
        expect(w.status, out(w)).toBe(1)
        expect(out(w)).toContain(place(f))
      }
    })
  }

  it('a commit message is blocked by the commit-msg hook and by the push and land scans', () => {
    const dir = scratchRepo('msg')
    const base = git(dir, 'rev-parse', 'HEAD')
    const msg = path.join(root, 'commit-message.txt')
    fs.writeFileSync(msg, 'fix: the zorblatt deploy\n\n# a git comment line is not published\n')
    const hook = sh('sh', ['.husky/commit-msg', msg], dir)
    expect(hook.status, out(hook)).toBe(1)
    expect(out(hook)).toContain('commit message line 1')
    fs.writeFileSync(path.join(dir, 'a.txt'), 'clean\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'fix: the zorblatt deploy')
    const land = sh('bun', ['scripts/leak-scan/scan-git.mjs', '--range', `${base}..HEAD`], dir)
    expect(land.status, out(land)).toBe(1)
    expect(out(land)).toMatch(/internal-tool at commit message line 1/)
  })

  it("a commit's author or committer address is blocked (a work address on a public commit)", () => {
    const dir = scratchRepo('ident')
    const base = git(dir, 'rev-parse', 'HEAD')
    fs.writeFileSync(path.join(dir, 'a.txt'), 'clean\n')
    git(dir, 'add', '-A')
    git(dir, '-c', 'user.email=pat@acmecorp.example', 'commit', '-qm', 'a clean change')
    const land = sh('bun', ['scripts/leak-scan/scan-git.mjs', '--range', `${base}..HEAD`], dir)
    expect(land.status, out(land)).toBe(1)
    expect(out(land)).toMatch(/work-email at commit author/)
    expect(out(land)).toMatch(/work-email at commit committer/)
  })

  it('a commit that adds no file still has its identity and message read (empty, delete-only, a commit-tree copy)', () => {
    const dir = scratchRepo('nofile')
    fs.writeFileSync(path.join(dir, 'old.txt'), 'clean\n')
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'a file to delete later')
    const base = git(dir, 'rev-parse', 'HEAD')
    // 1. a commit-tree copy of the parent's tree, committed by a work address
    const copy = sh('git', ['commit-tree', '-p', 'HEAD', '-m', 'a copy', 'HEAD^{tree}'], dir, {
      env: { ...process.env, GIT_COMMITTER_EMAIL: 'pat@acmecorp.example', GIT_COMMITTER_NAME: 'Pat' },
    }).stdout.trim()
    git(dir, 'reset', '-q', '--soft', copy)
    // 2. an empty commit authored by a work address
    git(dir, '-c', 'user.email=pat@acmecorp.example', 'commit', '-q', '--allow-empty', '-m', 'empty')
    // 3. a delete-only commit whose message names an internal tool
    git(dir, 'rm', '-q', 'old.txt'); git(dir, 'commit', '-qm', 'drop the zorblatt notes')
    for (const args of [['--range', `${base}..HEAD`], ['--history', 'HEAD']]) {
      const r = sh('bun', ['scripts/leak-scan/scan-git.mjs', ...args], dir)
      expect(r.status, out(r)).toBe(1)
      expect(out(r)).toContain(`work-email at commit committer (commit ${copy.slice(0, 10)})`)
      expect(out(r)).toMatch(/work-email at commit author/)
      expect(out(r)).toMatch(/internal-tool at commit message line 1/)
    }
    // the push hook sees them too
    const tip = git(dir, 'rev-parse', 'HEAD')
    const bare = path.join(root, 'nofile-remote.git')
    git(root, 'init', '-q', '--bare', bare)
    git(dir, 'push', '-q', bare, `${base}:refs/heads/main`)
    const push = sh('bash', ['scripts/leak-scan/scan-push.sh', 'origin', bare], dir, { input: `refs/heads/main ${tip} refs/heads/main ${base}\n` })
    expect(push.status, out(push)).toBe(1)
    expect(out(push)).toMatch(/work-email at commit committer/)
  })

  it('a word added and removed again inside one push is still blocked (each commit is public)', () => {
    const dir = scratchRepo('gone')
    const base = git(dir, 'rev-parse', 'HEAD')
    fs.writeFileSync(path.join(dir, 'a.md'), 'talk to marina-mbp\n')
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'one')
    fs.writeFileSync(path.join(dir, 'a.md'), 'talk to the box\n')
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'two')
    const land = sh('bun', ['scripts/leak-scan/scan-git.mjs', '--range', `${base}..HEAD`], dir)
    expect(land.status, out(land)).toBe(1)
    expect(out(land)).toMatch(/private-host at a\.md:1/)
  })

  it('a file over 2 MB is blocked', () => {
    const dir = scratchRepo('big')
    const base = git(dir, 'rev-parse', 'HEAD')
    fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.alloc(2 * 1024 * 1024 + 10, 1))
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'big')
    const land = sh('bun', ['scripts/leak-scan/scan-git.mjs', '--range', `${base}..HEAD`], dir)
    expect(land.status, out(land)).toBe(1)
    expect(out(land)).toMatch(/large-file at blob\.bin/)
  })

  it('the text inside a binary file is read', () => {
    const dir = scratchRepo('bin')
    const base = git(dir, 'rev-parse', 'HEAD')
    fs.writeFileSync(path.join(dir, 'data.bin'), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from('the deploy notes say zorblatt runs nightly here'), Buffer.from([0, 0, 3])]))
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'binary')
    const land = sh('bun', ['scripts/leak-scan/scan-git.mjs', '--range', `${base}..HEAD`], dir)
    expect(land.status, out(land)).toBe(1)
    expect(out(land)).toMatch(/internal-tool at data\.bin \(binary/)
  })

  it.runIf(HAS_GITLEAKS)('a credential gitleaks knows is blocked at the commit and the land', () => {
    const dir = scratchRepo('gl')
    const base = git(dir, 'rev-parse', 'HEAD')
    fs.writeFileSync(path.join(dir, 'cfg.ts'), `export const gh = '${'gh' + 'p_'}${token(36)}'\n`)
    git(dir, 'add', '-A')
    const pre = sh('sh', ['.husky/pre-commit'], dir)
    expect(pre.status, out(pre)).toBe(1)
    expect(out(pre)).toMatch(/gitleaks:github-pat at cfg\.ts:1/)
    git(dir, 'commit', '-qm', 'cfg')
    const land = sh('bun', ['scripts/leak-scan/scan-git.mjs', '--range', `${base}..HEAD`, '--strict', '--rules', rulesFile], dir)
    expect(land.status, out(land)).toBe(1)
    expect(out(land)).toMatch(/gitleaks:github-pat at cfg\.ts:1 \(commit /)
  })

  it('clean content passes every path', () => {
    const dir = scratchRepo('clean')
    const base = git(dir, 'rev-parse', 'HEAD')
    fs.mkdirSync(path.join(dir, 'docs', 'assets'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'docs', 'assets', 'logo.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
    fs.writeFileSync(path.join(dir, 'src.ts'), "export const home = '/Users/me/project'\n// talks to marina over the tunnel\n")
    fs.mkdirSync(path.join(dir, 'tests', 'fixtures'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'tests', 'fixtures', 'replay.jsonl'), '{"type":"user"}\n')
    git(dir, 'add', '-A')
    const pre = sh('sh', ['.husky/pre-commit'], dir)
    expect(pre.status, out(pre)).toBe(0)
    git(dir, 'commit', '-qm', 'clean docs and code')
    const land = sh('bun', ['scripts/leak-scan/scan-git.mjs', '--range', `${base}..HEAD`], dir)
    expect(land.status, out(land)).toBe(0)
    expect(out(land)).toMatch(/scan-git: clean/)
  })
})

describe('the 2026-11-14 review: content that reached GitHub unread', () => {
  const binWithWord = () => Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from('the deploy notes say zorblatt runs nightly here'), Buffer.from([0, 0, 3])])
  const range = (dir: string, base: string, extra: string[] = []) => sh('bun', ['scripts/leak-scan/scan-git.mjs', '--range', `${base}..HEAD`, ...extra], dir)

  it('a binary is read whatever its name or the diff prefix config', () => {
    const dir = scratchRepo('binnames')
    const base = git(dir, 'rev-parse', 'HEAD')
    for (const name of ['we"ird.bin', 'this and that.bin']) fs.writeFileSync(path.join(dir, name), binWithWord())
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'names')
    const r = range(dir, base)
    expect(r.status, out(r)).toBe(1)
    expect(out(r)).toContain('internal-tool at we"ird.bin (binary')
    expect(out(r)).toContain('internal-tool at this and that.bin (binary')
    // staged, with the prefix config a user or `git -c` can set
    const dir2 = scratchRepo('mnemonic')
    git(dir2, 'config', 'diff.mnemonicPrefix', 'true')
    fs.writeFileSync(path.join(dir2, 'data.bin'), binWithWord())
    git(dir2, 'add', '-A')
    const st = sh('bun', ['scripts/leak-scan/scan-git.mjs', '--staged'], dir2)
    expect(st.status, out(st)).toBe(1)
    expect(out(st)).toContain('internal-tool at data.bin (binary')
  })

  it('a UTF-16 text file is read as text', () => {
    const dir = scratchRepo('utf16')
    const base = git(dir, 'rev-parse', 'HEAD')
    fs.writeFileSync(path.join(dir, 'notes.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('line one\nask zorblatt\n', 'utf16le')]))
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'utf16')
    const r = range(dir, base)
    expect(r.status, out(r)).toBe(1)
    expect(out(r)).toContain('internal-tool at notes.txt:2 (UTF-16)')
  })

  it('an archive or office document outside the asset and fixture folders is blocked (its text is compressed)', () => {
    const dir = scratchRepo('opaque')
    const base = git(dir, 'rev-parse', 'HEAD')
    fs.writeFileSync(path.join(dir, 'export.zip'), Buffer.from('504b0304', 'hex'))
    fs.mkdirSync(path.join(dir, 'tests', 'fixtures'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'tests', 'fixtures', 'doc.docx'), Buffer.from('504b0304', 'hex'))
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'opaque')
    const r = range(dir, base)
    expect(r.status, out(r)).toBe(1)
    expect(out(r)).toContain('opaque-file-outside-assets at export.zip')
    expect(out(r)).not.toContain('doc.docx')
  })

  it.runIf(HAS_GITLEAKS)("gitleaks reads neither a working tree's .gitleaksignore nor an inline allow comment", () => {
    const dir = scratchRepo('glignore')
    const base = git(dir, 'rev-parse', 'HEAD')
    fs.writeFileSync(path.join(dir, 'cfg.ts'), `export const gh = '${'gh' + 'p_'}${token(36)}'\n`)
    fs.writeFileSync(path.join(dir, 'other.ts'), `export const gh2 = '${'gh' + 'p_'}${token(36)}' // ${'gitleaks' + ':allow'}\n`)
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'cfg')
    // an uncommitted ignore file naming the finding, as a peer's edit in a shared tree could
    const fp = JSON.parse(sh('gitleaks', ['git', '--no-banner', '--redact', '--report-format', 'json', '--report-path', '-', `--log-opts=${base}..HEAD`, '.'], dir).stdout || '[]')
    fs.writeFileSync(path.join(dir, '.gitleaksignore'), fp.map((f: { Fingerprint: string }) => f.Fingerprint).join('\n') + '\n')
    const r = range(dir, base)
    expect(r.status, out(r)).toBe(1)
    expect(fp.length, 'gitleaks itself finds the unmarked key').toBeGreaterThan(0)
    expect(out(r)).toMatch(/gitleaks:github-pat at cfg\.ts:1/)
    expect(out(r)).toMatch(/gitleaks-allow at other\.ts:1/)
  })

  it('a push of a ref to a blob or a tree is refused', () => {
    const dir = scratchRepo('blobref')
    const blob = sh('git', ['hash-object', '-w', '--stdin'], dir, { input: 'raw content\n' }).stdout.trim()
    const r = sh('bash', ['scripts/leak-scan/scan-push.sh', 'origin', 'x'], dir, { input: `refs/tags/raw ${blob} refs/tags/raw ${'0'.repeat(40)}\n` })
    expect(r.status, out(r)).toBe(1)
    expect(out(r)).toMatch(/points at a blob, not a commit/)
  })

  it("an annotated tag's message and tagger are read", () => {
    const dir = scratchRepo('tag')
    git(dir, '-c', 'user.email=pat@acmecorp.example', 'tag', '-a', 'v1', '-m', 'release for zorblatt')
    const tag = git(dir, 'rev-parse', 'v1')
    const head = git(dir, 'rev-parse', 'HEAD')
    const r = sh('bash', ['scripts/leak-scan/scan-push.sh', 'origin', 'x'], dir, { input: `refs/tags/v1 ${tag} refs/tags/v1 ${'0'.repeat(40)}\nrefs/heads/main ${head} refs/heads/main ${head}\n` })
    expect(r.status, out(r)).toBe(1)
    expect(out(r)).toMatch(/work-email at commit message line 1/)
    expect(out(r)).toMatch(/internal-tool at commit message line 3/)
  })
})

describe('no way to skip the scan', () => {
  it('there is no option that skips a check', () => {
    const dir = scratchRepo('opts')
    for (const flag of ['--no-gitleaks', '--skip', '--allow', '--no-private', '--force']) {
      const r = sh('bun', ['scripts/leak-scan/scan-git.mjs', '--staged', flag], dir)
      expect(r.status, flag).toBe(2)
      expect(out(r)).toMatch(/unknown option/)
    }
  })

  it('strict (the maintainer, CI upstream) refuses without the private rules, and without gitleaks', () => {
    const dir = scratchRepo('strict')
    git(dir, 'config', '--unset', 'walnut.leakRules')
    const noRules = sh('bun', ['scripts/leak-scan/scan-git.mjs', '--staged'], dir, { env: { WALNUT_LEAK_STRICT: '1' } })
    expect(noRules.status, out(noRules)).toBe(2)
    expect(out(noRules)).toMatch(/private leak rules are missing/)
    git(dir, 'config', 'walnut.leakRules', rulesFile)
    const bin = path.join(root, 'nogl-bin')
    fs.mkdirSync(bin, { recursive: true })
    for (const t of ['git', 'tar', 'sh', 'bash']) {
      const p = spawnSync('which', [t], { encoding: 'utf8' }).stdout.trim()
      if (p && !fs.existsSync(path.join(bin, t))) fs.symlinkSync(p, path.join(bin, t))
    }
    const noGl = spawnSync(process.execPath, ['scripts/leak-scan/scan-git.mjs', '--staged', '--strict', '--rules', rulesFile], { cwd: dir, env: { ...env, PATH: bin }, encoding: 'utf8' })
    expect(noGl.status, out(noGl)).toBe(2)
    expect(out(noGl)).toMatch(/gitleaks is not installed/)
  })

  it('the maintainer machine is strict by itself (a ~/.config/walnut-leak folder)', () => {
    const dir = scratchRepo('auto-strict')
    git(dir, 'config', '--unset', 'walnut.leakRules')
    const home = path.join(root, 'home-maint')
    fs.mkdirSync(path.join(home, '.config', 'walnut-leak'), { recursive: true })
    const r = sh('bun', ['scripts/leak-scan/scan-git.mjs', '--staged'], dir, { env: { HOME: home } })
    expect(r.status, out(r)).toBe(2)
  })

  it("a change cannot loosen the scan that judges it: the base commit's scanner and rules decide", () => {
    const dir = scratchRepo('loosen')
    const base = git(dir, 'rev-parse', 'HEAD')
    // the change drops the shape rule and adds a credential of that shape in one commit
    const shapes = path.join(dir, 'scripts', 'leak-scan', 'shapes.tsv')
    fs.writeFileSync(shapes, fs.readFileSync(shapes, 'utf8').split('\n').filter((l) => !l.startsWith('bedrock-api-key')).join('\n'))
    fs.writeFileSync(path.join(dir, 'k.ts'), `export const k = '${'AB' + 'SK'}${token(56)}'\n`)
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'loosen and add')
    const tipScanner = sh('bun', ['scripts/leak-scan/scan-git.mjs', '--range', `${base}..HEAD`], dir)
    expect(tipScanner.status, out(tipScanner)).toBe(1)
    expect(out(tipScanner)).toMatch(/bedrock-api-key at k\.ts:1/)
  })
})

describe('rule sets', () => {
  it('a source-only rule judges what git publishes, never an artifact', () => {
    const json = compileRules(parseSource(PRIVATE_TSV))
    const labels = (scope?: string) => scanText(loadRules(json, scope ? { scope } : undefined), 'the quibbleton tool').map((h) => h.label)
    expect(labels('source')).toEqual(['internal-tool-word'])
    expect(labels()).toEqual([])
  })

  it('a rule secret may be JSON, base64 of it, or base64 of its gzip (a secret holds 48 KB at most)', () => {
    const json = JSON.stringify(compileRules(parseSource(PRIVATE_TSV)))
    expect(decodeRules(json)).toBe(json)
    expect(decodeRules(Buffer.from(json).toString('base64'))).toBe(json)
    expect(decodeRules(gzipSync(json).toString('base64'))).toBe(json)
  })
})

describe('reading git output', () => {
  it('maps added lines to their line numbers, across hunks, and reads quoted names', () => {
    const units: Array<{ files: Array<{ path: string; lines: Array<[number, string]> }> }> = []
    const p = lineParser((u: never) => units.push(u))
    for (const l of [
      'diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts',
      '@@ -3,0 +4,2 @@', '+four', '+five', '@@ -10 +12 @@', '-old', '+twelve',
      'diff --git "a/sp ace.md" "b/sp ace.md"', '--- /dev/null', '+++ "b/sp ace.md"', '@@ -0,0 +1 @@', '+one',
    ]) p.line(l)
    p.end()
    expect(units).toHaveLength(1)
    expect(units[0].files.map((f) => [f.path, f.lines])).toEqual([
      ['x.ts', [[4, 'four'], [5, 'five'], [12, 'twelve']]],
      ['sp ace.md', [[1, 'one']]],
    ])
    // a C-quoted name with a tab and the UTF-8 bytes of U+00E9
    expect(unquote('"a\\tb\\303\\251"')).toBe('a\tb\u00e9')
  })
})
