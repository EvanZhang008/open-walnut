/**
 * Every web caller that asks for a history delta (`fetchSessionHistory` with `since`) takes the
 * server's stale delta: while the session's host is not reachable now, a delta answers 200
 * `{ messages: [], delta: true, stale: true }` with no cursor (src/web/routes/sessions.ts,
 * `staleOk=1`, which fetchSessionHistory sends on every delta). A caller that merged it as an
 * ordinary delta would move its cursor off nothing; each one checks `.stale` first.
 *
 * 2026-11-27: every leader restart re-read each open remote session as a delta before the link
 * came back, 218 503s that day. The callers are enumerated from the source, so a new one that
 * does not check fails here.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const WEB = path.join(ROOT, 'web/src')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

/** Calls that read a history delta: fetchSessionHistory, or a wrapper taking its options, with `since`. */
const DELTA_READERS = /\b(fetchSessionHistory|fetchJoiningLoad)\(/

function deltaCallers(): Array<{ key: string; after: string }> {
  const sites: Array<{ key: string; after: string }> = []
  for (const file of sourceFiles(WEB)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!DELTA_READERS.test(line) || /^\s*(export\s+)?async function /.test(line)) return
      const args = lines.slice(i, i + 12).join('\n').split(/\)\s*\n?\s*\.then/)[0]
      if (!/\bsince\b/.test(args)) return
      sites.push({ key: `${path.relative(ROOT, file)}:${i + 1}`, after: lines.slice(i, i + 40).join('\n') })
    })
  }
  return sites
}

/** The `.then((result) =>` callback's result checks `result.stale` before it merges (planDeltaMerge) or stores. */
function checksOwnStaleFirst(after: string): boolean {
  const m = /\.then\(\s*\(?\s*(\w+)\s*\)?\s*=>/.exec(after)
  if (!m) return false
  const body = after.slice(m.index + m[0].length)
  const stale = body.search(new RegExp(`\\b${m[1]}\\.stale\\b`))
  const merge = body.search(/planDeltaMerge\(|historyCacheSet\(|setHistoryCache\(/)
  return stale !== -1 && (merge === -1 || stale < merge)
}

describe('every history delta caller takes a stale delta', () => {
  const sites = deltaCallers()

  it('finds the delta callers', () => {
    expect(sites.map((s) => s.key.split(':')[0]).sort()).toEqual(expect.arrayContaining([
      'web/src/cache/session-cache.ts', 'web/src/hooks/useSessionHistory.ts',
    ]))
  })

  it.each(sites.map((s) => [s.key, s.after]))('%s checks its own result\'s .stale before it merges', (_key, after) => {
    expect(checksOwnStaleFirst(after), 'check the result\'s `stale` before merging the delta: a stale delta has no rows and no cursor').toBe(true)
  })

  it('the check itself tells a caller that forgets from one that checks', () => {
    expect(checksOwnStaleFirst('x.then((r) => {\n if (r.stale) return\n planDeltaMerge(a, r)')).toBe(true)
    expect(checksOwnStaleFirst('x.then((r) => {\n planDeltaMerge(a, r)\n if (full.stale) return')).toBe(false)
    expect(checksOwnStaleFirst('x.then((r) => {\n planDeltaMerge(a, r)\n if (r.stale) return')).toBe(false)
  })

  it('every delta asks with staleOk, so the server answers stale instead of 503', () => {
    const api = fs.readFileSync(path.join(WEB, 'api/sessions.ts'), 'utf8')
    const block = /if \(opts\?\.since !== undefined\) \{([\s\S]*?)\n {2}\}/.exec(api)?.[1] ?? ''
    expect(block).toContain("params.staleOk = '1'")
  })
})
