/**
 * scripts/leak-scan: the public leak scan for what Walnut publishes outside git (npm
 * tarballs, release assets, the site, Actions logs). Every rule here is an invented
 * neutral word; the real rule source is private and never in this repo.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { compileRules, loadRules, scanText, printableRuns, runOffset, termKey } from '../../scripts/leak-scan/core.mjs'
import { reapStale } from '../../scripts/leak-scan/leak-scan.mjs'
import { parseSource } from '../../scripts/leak-scan/build-rules.mjs'

const REPO = path.join(import.meta.dirname, '..', '..')
const CLI = path.join(REPO, 'scripts', 'leak-scan', 'leak-scan.mjs')
const BUILD = path.join(REPO, 'scripts', 'leak-scan', 'build-rules.mjs')

const SOURCE = [
  '# invented rules',
  'corp-email\tregex\t(?<=[a-z0-9._-])@acmecorp\\.example\\b',
  'host-scheme\tregex\t\\bbox-qz-[a-z0-9]',
  'demo-key\tregex-cs\t\\bQK_[A-Z0-9]{20}\\b\tPLACEHOLDER',
  'tool\tterm\tzorblax',
  'tool\tterm\tQuanta Fizzle',
  'account\tterm\t123456789012',
  'acronym\tterm-cs\tQXZ',
].join('\n')

const rules = () => loadRules(compileRules(parseSource(SOURCE)))
const labels = (text: string) => scanText(rules(), text).map((h) => h.label)

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'leak-scan-test-'))
}

function writeRules(dir: string): string {
  const src = path.join(dir, 'src.tsv')
  fs.writeFileSync(src, SOURCE)
  const out = path.join(dir, 'rules.json')
  execFileSync(process.execPath, [BUILD, src, '--out', out], { stdio: 'pipe' })
  return out
}

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('leak-scan rules', () => {
  it('keeps no term in the clear', () => {
    const json = JSON.stringify(compileRules(parseSource(SOURCE)))
    for (const word of ['zorblax', 'Quanta', 'Fizzle', '123456789012', 'QXZ']) expect(json).not.toContain(word)
  })

  it('matches a term on word boundaries, any case, whatever joins its words', () => {
    expect(labels('see ZORBLAX here')).toEqual(['tool'])
    expect(labels('/opt/zorblax/bin')).toEqual(['tool'])
    expect(labels('zorblax_sync and zorblax-cli')).toEqual(['tool', 'tool'])
    expect(labels('zorblaxer unzorblax')).toEqual([])
    for (const t of ['quanta fizzle', 'Quanta-Fizzle', 'quanta_fizzle', 'Quanta.Fizzle', 'quanta\n  fizzle']) {
      expect(labels(t)).toEqual(['tool'])
    }
    expect(labels('quantafizzle')).toEqual([])
    expect(labels('account 123456789012:role')).toEqual(['account'])
    expect(labels('1123456789012')).toEqual([])
  })

  it('matches a case-sensitive term only as written and never inside an identifier', () => {
    expect(labels('the QXZ build')).toEqual(['acronym'])
    expect(labels('the qxz build')).toEqual([])
    expect(labels('MAX_QXZ = 4')).toEqual([])
  })

  it('applies regex rules with their allow list', () => {
    expect(labels('mail jo.doe@acmecorp.example now')).toEqual(['corp-email'])
    expect(labels('ssh box-qz-01.example')).toEqual(['host-scheme'])
    expect(labels('key QK_ABCDEFGHIJ0123456789 set')).toEqual(['demo-key'])
    expect(labels('key QK_ABCDEFGHIJ0123456789 PLACEHOLDER')).toEqual([])
  })

  it('reports the offset and length of each hit', () => {
    const text = 'xx Quanta  Fizzle yy'
    const [h] = scanText(rules(), text)
    expect(text.slice(h.offset, h.offset + h.length)).toBe('Quanta  Fizzle')
  })

  it('handles Unicode and an empty text', () => {
    expect(labels('')).toEqual([])
    expect(labels('你好zorblax世界')).toEqual(['tool'])
  })

  it('refuses a malformed or empty rule set', () => {
    expect(() => loadRules({})).toThrow(/not a leak-scan rule set/)
    expect(() => loadRules({ version: 1, regex: [], terms: [] })).toThrow(/empty/)
    expect(() => compileRules([{ label: 'x', kind: 'regex', value: '(' }])).toThrow()
    expect(() => compileRules([{ label: 'x', kind: 'term', value: '--' }])).toThrow(/no letters/)
    expect(() => parseSource('justone')).toThrow(/line 1/)
    expect(termKey('A-b  C', false)).toBe('a b c')
  })

  it('maps a binary file to its long printable runs and back to byte offsets', () => {
    const buf = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('zorblax'), Buffer.from([0]), Buffer.from('path/zorblax/x'), Buffer.from([0, 0])])
    const runs = printableRuns(buf)
    // the 7-byte run is below the minimum: a short run in binary data is noise
    expect(runs.text).toBe('path/zorblax/x')
    const [h] = scanText(rules(), runs.text)
    const at = runOffset(runs, h.offset)
    expect(buf.toString('latin1', at, at + 7)).toBe('zorblax')
  })

  it('sees a term through string escapes and inside identifiers', () => {
    expect(labels('"Hello\\nzorblax"')).toEqual(['tool'])
    expect(labels('{"body":"a\\u0020zorblax\\tok"}')).toEqual(['tool'])
    expect(labels('https://x.example/a%2Fzorblax')).toEqual(['tool'])
    expect(labels('const zorblaxClient = new HTTPZorblax(zorblax2)')).toEqual(['tool', 'tool', 'tool'])
    expect(labels('unzorblax zorblaxer')).toEqual([])
  })

  it('keeps short C strings and UTF-8 runs of a binary, drops short noise', () => {
    // test data: two CJK characters (UTF-8, 6 bytes) then the term, so the run is 13 bytes
    const cjk = Buffer.from('\u4f60\u597dzorblax', 'utf8')
    const buf = Buffer.concat([Buffer.from([0]), Buffer.from('zorblax'), Buffer.from([0, 0x9f, 0x01]), Buffer.from('Quanta'), Buffer.from([0x01]), cjk, Buffer.from([0x02])])
    const runs = printableRuns(buf)
    expect(runs.parts).toEqual(['zorblax', cjk.toString('latin1')])
    expect(scanText(rules(), runs.text).map((h) => h.label)).toEqual(['tool', 'tool'])
  })

  it('never reads a phrase across two printable runs of a binary', () => {
    // A nightly's compressed bytes held a run ending in one word of a two-word term and the
    // next run starting with the other: a hit in all six files from bytes no string held.
    const split = Buffer.concat([Buffer.from([0]), Buffer.from('xxx Quanta'), Buffer.from([0x01, 0x9f]), Buffer.from('Fizzle yyy'), Buffer.from([0])])
    const runs = printableRuns(split)
    expect(runs.parts).toEqual(['xxx Quanta', 'Fizzle yyy'])
    expect(scanText(rules(), runs.text)).toEqual([])
    // the same phrase inside one run is still a hit, and a single word still is across runs
    const whole = printableRuns(Buffer.concat([Buffer.from([0]), Buffer.from('a Quanta-Fizzle b'), Buffer.from([0x01]), Buffer.from('zorblax!'), Buffer.from([0])]))
    expect(scanText(rules(), whole.text).map((h) => h.label)).toEqual(['tool', 'tool'])
  })

  it('refuses a term rule with a malformed hash', () => {
    const json = compileRules(parseSource(SOURCE))
    expect(() => loadRules({ ...json, terms: [{ label: 'x', h: 'zz', n: 1 }] })).toThrow(/malformed term rule/)
    expect(() => loadRules({ ...json, terms: [{ label: 'x', h: '00000000000000', n: 2 }] })).toThrow(/malformed term rule/)
  })

  it('refuses a regex that opens with a repeated class, which is quadratic on a long run', () => {
    // the last one opens with a single class, so only timing it on a long run finds it
    for (const bad of ['[a-z0-9.]+@acmecorp\\.example', '\\w+\\.acmecorp', '([a-z]+)@x', '.*zorblax', '[a-z][a-z0-9]*\\.acmecorp']) {
      expect(() => compileRules([{ label: 'x', kind: 'regex', value: bad }])).toThrow(/repeated character class/)
      expect(() => loadRules({ version: 1, regex: [{ label: 'x', source: bad }], terms: [] })).toThrow(/repeated character class/)
    }
    // the same rule written from its literal, with the class in a lookbehind
    const r = loadRules(compileRules([{ label: 'corp-email', kind: 'regex', value: '(?<=[a-z0-9._-])@acmecorp\\.example\\b' }]))
    expect(scanText(r, 'mail jo.doe@acmecorp.example now').map((h) => h.label)).toEqual(['corp-email'])
    expect(scanText(r, 'mail @acmecorp.example now')).toEqual([])
    const t0 = Date.now()
    expect(scanText(r, 'a'.repeat(400_000))).toEqual([])
    expect(Date.now() - t0).toBeLessThan(5_000)
  })

  it('gives the same hits for a word it has seen before, in any case and inside identifiers', () => {
    const r = rules()
    const text = 'zorblax x ZORBLAX zorblaxClient unzorblax Quanta Fizzle quanta zorblax the QXZ build QXZ'
    const first = scanText(r, text)
    expect(first.map((h) => h.label)).toEqual(['tool', 'tool', 'tool', 'tool', 'tool', 'acronym', 'acronym'])
    expect(scanText(r, text)).toEqual(first)
    expect(scanText(r, 'Quanta zorblax').map((h) => h.label)).toEqual(['tool'])
    // a remembered case-sensitive word still skips the end of an UPPER_SNAKE name
    const cs = 'QXZ MAX_QXZ QXZ MAX_QXZ'
    expect(scanText(r, cs).map((h) => h.offset)).toEqual([0, 12])
    expect(scanText(r, cs).map((h) => h.offset)).toEqual([0, 12])
    // a long word is not remembered, and still found
    const long = `a${'b'.repeat(80)}Zorblax`
    expect(scanText(r, long)).toEqual(scanText(r, long))
    expect(scanText(r, long).map((h) => [h.offset, h.length])).toEqual([[81, 7]])
  })

  it('scans a 40 MB text in reasonable time', () => {
    const big = `${'lorem ipsum dolor sit amet, consectetur 12345 '.repeat(900_000)}zorblax`
    const t0 = Date.now()
    expect(labels(big)).toEqual(['tool'])
    expect(Date.now() - t0).toBeLessThan(60_000)
  })
})

describe('leak-scan CLI', () => {
  it('finds hits in files, binaries, tarballs and zips, and exits 1', () => {
    const dir = tmp()
    try {
      const r = writeRules(dir)
      const tree = path.join(dir, 'pkg')
      fs.mkdirSync(path.join(tree, 'package', 'dist'), { recursive: true })
      fs.writeFileSync(path.join(tree, 'package', 'README.md'), 'clean text only\n')
      fs.writeFileSync(path.join(tree, 'package', 'dist', 'cli.js'), 'const host = "box-qz-7.internal"\n')
      fs.writeFileSync(path.join(tree, 'package', 'dist', 'walnut'), Buffer.concat([Buffer.alloc(64), Buffer.from('/home/runner/zorblax/build.ts'), Buffer.alloc(64)]))
      const tgz = path.join(dir, 'pkg-1.0.0.tgz')
      execFileSync('tar', ['-czf', tgz, '-C', tree, 'package'])
      const logs = path.join(dir, 'logs')
      fs.mkdirSync(logs)
      fs.writeFileSync(path.join(logs, '1_build.txt'), '2026-01-01T00:00:00Z mail jo@acmecorp.example\n')
      const zip = path.join(dir, 'run-logs.zip')
      execFileSync('zip', ['-qr', zip, 'logs'], { cwd: dir })
      const res = run(['--rules', r, tgz, zip])
      expect(res.code).toBe(1)
      expect(res.out).toMatch(/HIT host-scheme \S*pkg-1\.0\.0\.tgz!\/package\/dist\/cli\.js @\d+/)
      expect(res.out).toMatch(/HIT tool \S*pkg-1\.0\.0\.tgz!\/package\/dist\/walnut @\d+/)
      expect(res.out).toMatch(/HIT corp-email \S*run-logs\.zip!\/logs\/1_build\.txt/)
      expect(res.out).toMatch(/: 3 hits/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('scans file and directory names, and masks them in redacted output', () => {
    const dir = tmp()
    try {
      const r = writeRules(dir)
      const tree = path.join(dir, 'pkg')
      fs.mkdirSync(path.join(tree, 'package', 'zorblax'), { recursive: true })
      fs.writeFileSync(path.join(tree, 'package', 'zorblax', 'index.js'), 'export {}\n')
      const tgz = path.join(dir, 'p.tgz')
      execFileSync('tar', ['-czf', tgz, '-C', tree, 'package'])
      const red = run(['--rules', r, '--redact', tgz])
      expect(red.code).toBe(1)
      expect(red.out).toMatch(/HIT tool \S*p\.tgz!\/package\/\*{7} \(its name\)/)
      expect(red.out).not.toContain('zorblax')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prints only a count with --count-only', () => {
    const dir = tmp()
    try {
      const r = writeRules(dir)
      fs.writeFileSync(path.join(dir, 'comments.json'), '[{"body":"see Quanta Fizzle"}]')
      const res = run(['--rules', r, '--count-only', path.join(dir, 'comments.json')])
      expect(res.code).toBe(1)
      expect(res.out.trim().split('\n')).toEqual([expect.stringMatching(/^leak-scan: 1 files, \d+ bytes, 7 rules: 1 hits, 0 skipped$/)])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('finds a term across the 32 MB chunk boundary exactly once, at its byte offset', () => {
    const dir = tmp()
    try {
      const r = writeRules(dir)
      const at = 32 * 1024 * 1024 - 3
      const buf = Buffer.alloc(at + 64, 0x20)
      buf.write('zorblax', at, 'latin1')
      fs.writeFileSync(path.join(dir, 'big.txt'), buf)
      const res = run(['--rules', r, '--redact', path.join(dir, 'big.txt')])
      expect(res.code).toBe(1)
      expect(res.out.match(/HIT tool/g)).toHaveLength(1)
      expect(res.out).toContain(`@${at}`)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('opens .gz files, skips symlinks, and fails when it scanned too few files', () => {
    const dir = tmp()
    try {
      const r = writeRules(dir)
      const d = path.join(dir, 'd')
      fs.mkdirSync(d)
      fs.writeFileSync(path.join(dir, 'outside.txt'), 'zorblax')
      fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(d, 'link.txt'))
      fs.writeFileSync(path.join(d, 'log.txt'), 'mail jo@acmecorp.example')
      execFileSync('gzip', [path.join(d, 'log.txt')])
      const res = run(['--rules', r, d])
      expect(res.code).toBe(1)
      expect(res.out).toMatch(/HIT corp-email \S*log\.txt\.gz!\/log\.txt/)
      expect(res.out).not.toMatch(/HIT tool/)
      fs.mkdirSync(path.join(dir, 'empty'))
      const empty = run(['--rules', r, path.join(dir, 'empty')])
      expect(empty.code).toBe(2)
      expect(empty.out).toMatch(/fewer than --min-files 1/)
      expect(run(['--rules', r, '--min-files', '0', path.join(dir, 'empty')]).code).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('scans a file once when other archives carry the same bytes, and names the copies', () => {
    const dir = tmp()
    try {
      const r = writeRules(dir)
      const tree = path.join(dir, 'pkg')
      fs.mkdirSync(path.join(tree, 'package'), { recursive: true })
      fs.writeFileSync(path.join(tree, 'package', 'dep.js'), 'const zorblax = 1\n')
      fs.writeFileSync(path.join(tree, 'package', 'own.js'), 'export {}\n')
      execFileSync('tar', ['-czf', path.join(dir, 'a-linux.tgz'), '-C', tree, 'package'])
      fs.writeFileSync(path.join(tree, 'package', 'own.js'), 'export const host = "box-qz-9"\n')
      execFileSync('tar', ['-czf', path.join(dir, 'a-mac.tgz'), '-C', tree, 'package'])
      const res = run(['--rules', r, '--redact', path.join(dir, 'a-linux.tgz'), path.join(dir, 'a-mac.tgz')])
      expect(res.code).toBe(1)
      expect(res.out.match(/HIT tool/g)).toHaveLength(1)
      expect(res.out).toMatch(/HIT host-scheme \S*a-mac\.tgz!\/package\/own\.js/)
      expect(res.out).toMatch(/: 6 files \(1 copies of a file already scanned\), \d+ bytes, 7 rules: 2 hits/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('with --skip-deps leaves out the dependencies a package carries, never the package itself', () => {
    const dir = tmp()
    try {
      const r = writeRules(dir)
      const own = path.join(dir, 'rt', 'lib', 'node_modules', 'open-walnut')
      fs.mkdirSync(path.join(own, 'dist'), { recursive: true })
      fs.mkdirSync(path.join(own, 'node_modules', 'some-sdk'), { recursive: true })
      fs.writeFileSync(path.join(own, 'package.json'), '{"name":"open-walnut"}')
      fs.writeFileSync(path.join(own, 'dist', 'cli.js'), '// see box-qz-4\n')
      fs.writeFileSync(path.join(own, 'node_modules', 'some-sdk', 'README.md'), 'mail jo@acmecorp.example\n')
      const all = run(['--rules', r, '--redact', path.join(dir, 'rt')])
      expect(all.out).toMatch(/HIT corp-email/)
      const own1 = run(['--rules', r, '--redact', '--skip-deps', path.join(dir, 'rt')])
      expect(own1.code).toBe(1)
      expect(own1.out).toMatch(/HIT host-scheme \S*open-walnut\/dist\/cli\.js/)
      expect(own1.out).not.toMatch(/corp-email/)
      expect(own1.out).toMatch(/skipped the dependencies of 1 packages/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removes the temp dirs of a scan that was killed, and only those', () => {
    const dir = tmp()
    try {
      const mk = (name: string) => { fs.mkdirSync(path.join(dir, name, 'x'), { recursive: true }); return name }
      const dead = mk('leak-scan-999999-AbC123')
      const live = mk('leak-scan-424242-QwErTy')
      const own = mk(`leak-scan-${process.pid}-ZzZzZz`)
      const other = [mk('leak-scan-test-abcdef'), mk('leak-scan-Xy12Zq'), mk('unrelated')]
      expect(reapStale(dir, (pid: number) => pid === 424242)).toBe(1)
      const left = fs.readdirSync(dir).sort()
      expect(left).not.toContain(dead)
      expect(left).toEqual([live, own, ...other].sort())
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never prints the matched text with --redact', () => {
    const dir = tmp()
    try {
      const r = writeRules(dir)
      fs.writeFileSync(path.join(dir, 'a.txt'), 'see Quanta Fizzle and 123456789012\n')
      const plain = run(['--rules', r, path.join(dir, 'a.txt')])
      expect(plain.out).toContain('Quanta Fizzle')
      const red = run(['--rules', r, '--redact', path.join(dir, 'a.txt')])
      expect(red.code).toBe(1)
      expect(red.out).toMatch(/HIT tool .*a\.txt @4\n/)
      for (const w of ['Quanta', 'Fizzle', '123456789012']) expect(red.out).not.toContain(w)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exits 0 on a clean tree and skips excluded directories', () => {
    const dir = tmp()
    try {
      const r = writeRules(dir)
      fs.mkdirSync(path.join(dir, 'site', 'node_modules'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'site', 'index.html'), '<h1>hello</h1>')
      fs.writeFileSync(path.join(dir, 'site', 'empty.txt'), '')
      fs.writeFileSync(path.join(dir, 'site', 'node_modules', 'x.js'), 'zorblax')
      const res = run(['--rules', r, '--exclude', 'node_modules', path.join(dir, 'site')])
      expect(res.code).toBe(0)
      expect(res.out).toMatch(/2 files, 14 bytes, 7 rules: 0 hits, 0 skipped/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads rules from an env var, raw or base64, and fails closed without them', () => {
    const dir = tmp()
    try {
      const r = writeRules(dir)
      fs.writeFileSync(path.join(dir, 'a.txt'), 'zorblax')
      const json = fs.readFileSync(r, 'utf8')
      expect(run(['--rules-env', 'LS_RULES', path.join(dir, 'a.txt')], { LS_RULES: json }).code).toBe(1)
      expect(run(['--rules-env', 'LS_RULES', path.join(dir, 'a.txt')], { LS_RULES: Buffer.from(json).toString('base64') }).code).toBe(1)
      const none = run(['--rules-env', 'LS_RULES', path.join(dir, 'a.txt')], { LS_RULES: '' })
      expect(none.code).toBe(2)
      expect(none.out).toMatch(/no rules/)
      expect(run([path.join(dir, 'a.txt')]).code).toBe(2)
      expect(run(['--rules', r, path.join(dir, 'missing')]).code).toBe(2)
      fs.writeFileSync(path.join(dir, 'bad.json'), '{"version":1}')
      expect(run(['--rules', path.join(dir, 'bad.json'), path.join(dir, 'a.txt')]).code).toBe(2)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('counts an archive it cannot open as an error unless --skip-ok', () => {
    const dir = tmp()
    try {
      const r = writeRules(dir)
      fs.writeFileSync(path.join(dir, 'broken.zip'), 'not a zip at all')
      const res = run(['--rules', r, path.join(dir, 'broken.zip')])
      expect(res.code).toBe(2)
      expect(res.out).toMatch(/SKIPPED .*broken\.zip \(could not open/)
      expect(run(['--rules', r, '--skip-ok', path.join(dir, 'broken.zip')]).code).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
