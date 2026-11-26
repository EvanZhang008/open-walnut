/**
 * Browser specs set the server's experimental flags and put them back only through
 * tests/e2e/browser/server-flags.ts, because two hand-made ways leave a flag behind on the shared fixture:
 *
 * - Reading the flags off the top level of GET /api/config. The answer is `{ config: { experimental } }`,
 *   so such a read gets nothing, and a "put back" of nothing merges no flag. 2026-11-26, CI 45784774186:
 *   threads-turn-end-still left every_experiment on, quiet_rail took Routines off the rail, and three
 *   trigger specs waited on its rail link until their test timeout.
 * - Putting back a map read before (`experimental: flagsBefore`, `{ ...now, flag: on }`). The write merges
 *   flag by flag and removes only a flag sent as null, so a flag the map never had stays as the spec set
 *   it. 2026-11-26: resize-observer-loop.webkit left every_experiment and chat_glass_edges on for every
 *   WebKit spec after it, and change-status, topics, org-leaders, stt-compare and
 *   action-needed-everywhere left their own experiment on.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = path.resolve(__dirname, '../../tests/e2e/browser')

// The GET's JSON (`(await request.get('/api/config')).json()`, with or without the outer
// parentheses), then the flags taken at its top level: a cast naming them there, or `.experimental`.
const WRONG_LEVEL = /\.get\(\s*[`'"][^`'"\n]*\/api\/config[`'"]\s*\)\s*\)\s*\.json\(\)\s*\)?\s*(as\s*\{\s*experimental\b|\.experimental\b)/

// A file that reads the stored flags (GET /api/config's `config.experimental`) ...
const READS_FLAGS = /\bconfig\??\.experimental\b|config\??:\s*\{\s*experimental\b/
// ... and writes back a map, not the flags it names: `experimental: <name>` or `experimental: { ...<map>`.
const MAP_WRITE = /\.put\(\s*[`'"][^`'"\n]*\/api\/config[`'"]\s*,\s*\{\s*data:\s*\{\s*experimental:\s*(\{\s*\.\.\.|[A-Za-z_$][\w$]*\s*\})/

function offenders(file: string, text: string): string[] {
  const reads = READS_FLAGS.test(text)
  return text.split('\n').flatMap((line, i) => (WRONG_LEVEL.test(line) || (reads && MAP_WRITE.test(line)) ? [`${file}:${i + 1}: ${line.trim()}`] : []))
}

describe('server experimental flags in browser specs', () => {
  it('no spec reads them off the top level of the GET /api/config answer, or puts back a map it read', () => {
    const found = (fs.readdirSync(DIR, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts') && f !== 'server-flags.ts')
      .flatMap((f) => offenders(f, fs.readFileSync(path.join(DIR, f), 'utf8')))
    expect(found, 'set and put back server flags with serverFlags() or setServerFlags() from tests/e2e/browser/server-flags.ts').toEqual([])
  })

  it('catches a map put back over the flags it read, and leaves a write of named flags alone', () => {
    const read = `const cfg = await (await request.get('/api/config')).json() as { config?: { experimental?: Record<string, boolean> } }\n`
    const flag = (line: string, text = read) => offenders('x.spec.ts', text + line).length > 0
    expect(flag(`  if (flagsBefore) await request.put('/api/config', { data: { experimental: flagsBefore } })`)).toBe(true)
    expect(flag(`  const res = await request.put('/api/config', { data: { experimental: { ...now, [FLAG]: on } } })`)).toBe(true)
    expect(flag(`  await request.put(\`\${API}/api/config\`, { data: { experimental: restore } })`)).toBe(true)
    expect(flag(`  const res = await request.put('/api/config', { data: { experimental: { threads_pop_up: on } } })`)).toBe(false)
    // A map of new values in a file that never reads the stored flags is a write, not a put back.
    expect(flag(`  const res = await request.put('/api/config', { data: { experimental: { ...more, project_first_start: on } } })`, '')).toBe(false)
  })

  it('catches each form of the wrong read and leaves the right one alone', () => {
    const flag = (line: string) => offenders('x.spec.ts', line).length > 0
    expect(flag(`const cfg = await (await request.get('/api/config')).json() as { experimental?: Record<string, boolean> }`)).toBe(true)
    expect(flag(`x = ((await (await request.get('/api/config')).json()) as { experimental?: Record<string, boolean> }).experimental ?? {}`)).toBe(true)
    expect(flag('const f = (await (await page.request.get(`${API}/api/config`)).json()).experimental')).toBe(true)
    expect(flag(`const cfg = await (await request.get('/api/config')).json() as { config?: { experimental?: Record<string, boolean> } }`)).toBe(false)
    expect(flag(`const on = (await (await request.get('/api/config')).json()).config.experimental`)).toBe(false)
  })
})
