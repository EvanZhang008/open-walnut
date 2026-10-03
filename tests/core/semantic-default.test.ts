/**
 * Ratchet: an isolated Walnut server never loads the embedding model unless it
 * asks to (src/core/search/semantic-default.ts).
 *
 * One worker lane of the default model measured +2.2 GB of footprint
 * (2026-10-02), and a fresh data home downloads the model first (614 MB). Every
 * dev:ephemeral server rebuilt its index from the copied data and so loaded it,
 * next to the production server it was meant to leave alone. Three layers keep a
 * new test server from bringing that back silently:
 *  1. the decision itself (who counts as isolated);
 *  2. the server's real path in this test runner (no opt-in, no model);
 *  3. a static check that every embedder handed to a search index in src/ comes
 *     through that decision, so a new index cannot bypass it, and that the
 *     model's worker process is forked only by the embedder those indexes own.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { semanticLaneDecision, type SemanticLaneInputs } from '../../src/core/search/semantic-default.js'

const REPO = path.join(import.meta.dirname, '..', '..')
const TMP = ['/tmp', '/private/tmp', '/var/folders/xy/T']

describe('who loads the model', () => {
  const base: SemanticLaneInputs = { env: {}, isEphemeral: false, walnutHome: '/Users/someone/.open-walnut', tmpRoots: TMP }
  it.each([
    ['a real install', {}, 'default', true],
    ['the test runner', { env: { VITEST: 'true' } }, 'test-runner', false],
    ['a vitest worker', { env: { VITEST_WORKER_ID: '3' } }, 'test-runner', false],
    ['NODE_ENV=test', { env: { NODE_ENV: 'test' } }, 'test-runner', false],
    ['an ephemeral child (dev:ephemeral, the Playwright fixtures)', { isEphemeral: true }, 'ephemeral', false],
    ['a data home in /tmp (scripted throwaway servers)', { walnutHome: '/tmp/ios-e2e-1/home' }, 'temp-home', false],
    ['a data home in the user temp dir (the sandbox)', { walnutHome: '/var/folders/xy/T/walnut-sandbox/.open-walnut' }, 'temp-home', false],
    ['opt-in wins on an isolated server', { env: { VITEST: 'true', WALNUT_SEARCH_V2_SEMANTIC: '1' }, isEphemeral: true }, 'opt-in', true],
    ['opt-out wins on a real install', { env: { WALNUT_SEARCH_V2_SEMANTIC: '0' } }, 'opt-out', false],
    ['a home merely named like tmp is not a temp home', { walnutHome: '/Users/someone/tmp-notes/.open-walnut' }, 'default', true],
    ['the temp root itself is not inside it', { walnutHome: '/tmp' }, 'default', true],
  ] as const)('%s', (_name, over, reason, on) => {
    const d = semanticLaneDecision({ ...base, ...over, env: { ...(over as { env?: NodeJS.ProcessEnv }).env } })
    expect(d).toEqual({ on, reason })
  })
})

describe('this test runner, through the server path', () => {
  let saved: string | undefined
  beforeEach(() => { saved = process.env.WALNUT_SEARCH_V2_SEMANTIC; delete process.env.WALNUT_SEARCH_V2_SEMANTIC })
  afterEach(async () => {
    if (saved === undefined) delete process.env.WALNUT_SEARCH_V2_SEMANTIC
    else process.env.WALNUT_SEARCH_V2_SEMANTIC = saved
    const { resetSearchV2IndexForTests } = await import('../../src/core/search/wiring.js')
    resetSearchV2IndexForTests()
  })

  it('without an opt-in a test server has no model, even with the setup default removed', async () => {
    const wiring = await import('../../src/core/search/wiring.js')
    expect(wiring.currentSemanticLaneDecision()).toEqual({ on: false, reason: 'test-runner' })
    wiring.resetSearchV2IndexForTests()
    expect(wiring.getSearchIndexStatus().model).toBeNull()
  })

  it('an explicit opt-in turns the lane on', async () => {
    process.env.WALNUT_SEARCH_V2_SEMANTIC = '1'
    const wiring = await import('../../src/core/search/wiring.js')
    expect(wiring.currentSemanticLaneDecision()).toEqual({ on: true, reason: 'opt-in' })
  })
})

describe('no index in src/ gets an embedder around the decision', () => {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name)) files.push(p)
    }
  }
  walk(path.join(REPO, 'src'))
  const rel = (p: string) => path.relative(REPO, p)

  // The model lives in forked worker processes (embedder.ts, one per lane).
  // A fork of the worker script anywhere else would load a model copy that no
  // decision, suspend or idle release ever sees.
  it('the embed worker process is forked in one place, embedder.ts', () => {
    const forkers = files.filter((f) => {
      const text = fs.readFileSync(f, 'utf8')
      return /embed-worker/.test(text) && /\b(fork|spawn|spawnSync|execFile|execFileSync)\(|new Worker\(/.test(text)
    }).map(rel)
    expect(forkers).toEqual([path.join('src', 'lib', 'hybrid-search', 'embedder.ts')])
    const embedder = fs.readFileSync(path.join(REPO, 'src/lib/hybrid-search/embedder.ts'), 'utf8')
    expect(embedder.match(/\bfork\(/g)).toHaveLength(1)
  })

  it('inside the library only createSearchIndex makes an embedder, and only when handed a config', () => {
    const lib = files.filter((f) => rel(f).startsWith(path.join('src', 'lib', 'hybrid-search') + path.sep))
    // A call, not the definition in embedder.ts.
    const call = /(?<!function )\bcreateEmbedder\(/g
    const callers = lib.filter((f) => fs.readFileSync(f, 'utf8').match(call)).map(rel)
    expect(callers).toEqual([path.join('src', 'lib', 'hybrid-search', 'index.ts')])
    const index = fs.readFileSync(path.join(REPO, 'src/lib/hybrid-search/index.ts'), 'utf8')
    expect(index.match(call)).toHaveLength(1)
    expect(index).toMatch(/=\s*options\.embedder\s*\?\s*createEmbedder\(/)
  })

  it('createEmbedder is called only inside the search library', () => {
    const callers = files.filter((f) => /\bcreateEmbedder\(/.test(fs.readFileSync(f, 'utf8')))
      .map(rel).filter((f) => !f.startsWith(path.join('src', 'lib', 'hybrid-search') + path.sep))
    expect(callers).toEqual([])
  })

  it('every createSearchIndex call outside the library passes no embedder, or the decided one', () => {
    const offenders: string[] = []
    for (const f of files) {
      const r = rel(f)
      if (r.startsWith(path.join('src', 'lib', 'hybrid-search') + path.sep)) continue
      const text = fs.readFileSync(f, 'utf8')
      for (const m of text.matchAll(/createSearchIndex\(\{([\s\S]*?)\}\)/g)) {
        const body = m[1]
        if (!/\bembedder\s*:/.test(body)) continue
        if (!/\bembedder\s*:\s*buildEmbedderConfig\(\)/.test(body)) offenders.push(`${r}: ${body.trim().slice(0, 80)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('buildEmbedderConfig asks the decision before anything else', () => {
    const wiring = fs.readFileSync(path.join(REPO, 'src/core/search/wiring.ts'), 'utf8')
    const body = /function buildEmbedderConfig\(\)[^{]*\{([\s\S]*?)\n\}/.exec(wiring)?.[1] ?? ''
    const first = body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('//'))
    expect(first).toBe('const lane = currentSemanticLaneDecision();')
  })
})
