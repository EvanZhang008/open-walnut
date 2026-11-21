/**
 * A short engine CLI run leaves nothing in the temp dir (src/lib/cli-private-tmp.ts).
 *
 * 2026-11-21: every `opencode --version` (a bun-compiled binary) extracted an 860 KB
 * dylib into $TMPDIR and left it; the engine probe ran it ~250 times a day, 0.7 GB
 * on the Mac. The ratchet below finds every short engine CLI run in src/ from the
 * source and fails when a new one does not go through withPrivateTmp.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CLI_TMP_PREFIX, withPrivateTmp, sweepStalePrivateTmpForTest } from '../../src/lib/cli-private-tmp.js'
import { ACP_ENGINES } from '../../src/providers/agent-command-map.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const made: string[] = []
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

/** A stand-in for a bun-compiled CLI: drops a file into its TMPDIR and prints where. */
function fakeCli(env: NodeJS.ProcessEnv): Promise<string> {
  const script = "require('fs').writeFileSync(require('path').join(process.env.TMPDIR, '.1bff-00000000.dylib'), 'x'); process.stdout.write(process.env.TMPDIR)"
  return new Promise((resolve, reject) => execFile(process.execPath, ['-e', script], { env }, (err, out) => err ? reject(err) : resolve(String(out))))
}

describe('withPrivateTmp', () => {
  it('gives the CLI its own TMPDIR and removes it with what the CLI left', async () => {
    const dir = await withPrivateTmp(process.env, fakeCli)
    expect(path.basename(dir).startsWith(CLI_TMP_PREFIX)).toBe(true)
    expect(path.dirname(dir)).toBe(path.resolve(os.tmpdir()))
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('removes the dir when the CLI fails, and passes the failure on', async () => {
    let seen = ''
    await expect(withPrivateTmp(process.env, async (env) => { seen = env.TMPDIR!; throw new Error('boom') })).rejects.toThrow('boom')
    expect(seen).not.toBe('')
    expect(fs.existsSync(seen)).toBe(false)
  })

  it('keeps the caller env and sets TMP and TEMP too', async () => {
    const env = await withPrivateTmp({ ...process.env, WALNUT_X: '1' }, async (e) => e)
    expect(env.WALNUT_X).toBe('1')
    expect(env.TMP).toBe(env.TMPDIR)
    expect(env.TEMP).toBe(env.TMPDIR)
  })

  it('a stale sweep removes only old private dirs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-tmp-sweep-'))
    made.push(root)
    const old = path.join(root, `${CLI_TMP_PREFIX}old`)
    const fresh = path.join(root, `${CLI_TMP_PREFIX}fresh`)
    const other = path.join(root, 'someone-else')
    for (const d of [old, fresh, other]) fs.mkdirSync(d)
    const now = Date.now()
    const twoDaysAgo = new Date(now - 2 * 86_400_000)
    fs.utimesSync(old, twoDaysAgo, twoDaysAgo)
    fs.utimesSync(other, twoDaysAgo, twoDaysAgo)
    await sweepStalePrivateTmpForTest(root, now)
    expect(fs.existsSync(old)).toBe(false)
    expect(fs.existsSync(fresh)).toBe(true)
    expect(fs.existsSync(other)).toBe(true)
  })
})

// ── Ratchet: every short engine CLI run goes through withPrivateTmp ──

function srcFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...srcFiles(p))
    else if (/\.(ts|js|mjs)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p)
  }
  return out
}

/** The body of `function name(` in `text` (up to the next top-level closing brace). */
function functionBody(text: string, name: string): string | null {
  const at = text.search(new RegExp(`function\\s+${name}\\s*\\(`))
  if (at < 0) return null
  const end = text.indexOf('\n}\n', at)
  return end < 0 ? null : text.slice(at, end)
}

describe('ratchet: short engine CLI runs use a private TMPDIR', () => {
  const engines = [...new Set(['claude', ...ACP_ENGINES])].filter((e) => e !== 'custom')
  const literal = new RegExp(`\\b(execFile|execFileAsync|execa)\\(\\s*['"](${engines.join('|')})['"]`, 'g')
  const files = srcFiles(path.join(REPO, 'src'))

  it('finds the known call sites (the scan itself works)', () => {
    const hits = files.filter((f) => /versionArgs/.test(fs.readFileSync(f, 'utf8')))
    expect(hits.length).toBeGreaterThan(1)
  })

  it('the short adapter spawns that take a variable command are wrapped', () => {
    // probeAdapterModels starts an engine adapter only to read its model list, then kills it.
    const text = fs.readFileSync(path.join(REPO, 'src/providers/engine-model-probe.ts'), 'utf8')
    expect(functionBody(text, 'probeAdapterModels')).toContain('withPrivateTmp(')
  })

  it('a literal engine binary run with execFile is wrapped', () => {
    const bad: string[] = []
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8')
      for (const m of text.matchAll(literal)) {
        const before = text.slice(Math.max(0, m.index! - 300), m.index!)
        if (!before.includes('withPrivateTmp(')) bad.push(`${path.relative(REPO, f)}: ${m[0]}`)
      }
    }
    expect(bad, `Run these through withPrivateTmp (src/lib/cli-private-tmp.ts) so they leave nothing in $TMPDIR:\n${bad.join('\n')}`).toEqual([])
  })

  it('every function that runs an engine binary for its version is wrapped', () => {
    // The engine adapters' `versionArgs` probes: readVersion (engine-probe.ts),
    // runVersion (acp-host-artifacts.ts), and any new file that runs them.
    const bad: string[] = []
    const found: string[] = []
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8')
      if (!/\bversionArgs\b/.test(text)) continue
      for (const m of text.matchAll(/function\s+(\w*[Vv]ersion\w*)\s*\(/g)) {
        const body = functionBody(text, m[1])
        if (!body || !/\bexecFile/.test(body)) continue
        found.push(`${path.relative(REPO, f)}: ${m[1]}`)
        if (!body.includes('withPrivateTmp(')) bad.push(`${path.relative(REPO, f)}: ${m[1]}`)
      }
    }
    expect(found.length, found.join('\n')).toBeGreaterThanOrEqual(2)
    expect(bad, `Version probes that do not use withPrivateTmp:\n${bad.join('\n')}`).toEqual([])
  })
})
