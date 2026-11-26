/**
 * No browser spec reads the server's experimental flags off the top level of GET /api/config.
 *
 * The answer is `{ config: { experimental } }`, so such a read gets nothing, and a "put back" of
 * nothing is a PUT that merges no flag: the flag the spec turned on stays on for every spec after it
 * on the shared fixture. 2026-11-26, CI 45784774186: threads-turn-end-still left every_experiment
 * on, quiet_rail took Routines off the rail, and three trigger specs waited on its rail link until
 * their test timeout. Specs set and put back server flags with tests/e2e/browser/server-flags.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = path.resolve(__dirname, '../../tests/e2e/browser')

// The GET's JSON (`(await request.get('/api/config')).json()`, with or without the outer
// parentheses), then the flags taken at its top level: a cast naming them there, or `.experimental`.
const WRONG_LEVEL = /\.get\(\s*[`'"][^`'"\n]*\/api\/config[`'"]\s*\)\s*\)\s*\.json\(\)\s*\)?\s*(as\s*\{\s*experimental\b|\.experimental\b)/

function offenders(file: string, text: string): string[] {
  return text.split('\n').flatMap((line, i) => (WRONG_LEVEL.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : []))
}

describe('server experimental flags in browser specs', () => {
  it('no spec reads them off the top level of the GET /api/config answer', () => {
    const found = (fs.readdirSync(DIR, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'))
      .flatMap((f) => offenders(f, fs.readFileSync(path.join(DIR, f), 'utf8')))
    expect(found, 'the answer is { config: { experimental } }: use tests/e2e/browser/server-flags.ts').toEqual([])
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
