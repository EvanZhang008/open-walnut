/**
 * Every wait in stopServer() is bounded: it runs through shutdownStep
 * (src/web/shutdown-steps.ts), or it is one of the waits listed here with why.
 *
 * The class: a teardown step that waits on outside work with no end of its own
 * holds the whole shutdown into the 7 s bail, and every step after it is never
 * run. Members found so far: the HTTP close waiting on long polls (2026-11-10),
 * the external session importer's stop waiting on an import pass (2026-11-12).
 * A new `await` added to stopServer fails here until it is a shutdownStep.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.join(import.meta.dirname, '..', '..')

/** Waits that need no step, each with why. Matched against the text after `await `. */
const ALLOWED: Array<{ re: RegExp; why: string }> = [
  { re: /^shutdownStep\(/, why: 'the bounded step itself' },
  { re: /^\(?import\(/, why: 'a module import: the server already loaded it, so it resolves at once' },
  { re: /^Promise\.all\(\[\s*import\([^)]*\),\s*import\([^)]*\),?\s*\]\)/, why: 'module imports only' },
  { re: /^closeHttpServer\(/, why: 'bounded on its own: idle sockets at once, the rest after HTTP_DRAIN_GRACE_MS (http-close.ts)' },
]

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
}

/** The body of `export async function <name>(` up to its matching brace. */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`)
  expect(start, `${name} not found`).toBeGreaterThanOrEqual(0)
  const open = src.indexOf('{', src.indexOf(')', start))
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i)
  }
  throw new Error(`${name}: no closing brace`)
}

/** Remove the argument list of every `shutdownStep(` call: waits inside a step are its own. */
function withoutStepBodies(body: string): string {
  let out = ''
  let i = 0
  for (;;) {
    const at = body.indexOf('shutdownStep(', i)
    if (at < 0) return out + body.slice(i)
    const open = at + 'shutdownStep'.length
    out += body.slice(i, open + 1)
    let depth = 0
    let j = open
    for (; j < body.length; j++) {
      if (body[j] === '(') depth++
      else if (body[j] === ')' && --depth === 0) break
    }
    out += ')'
    i = j + 1
  }
}

function unboundedWaits(src: string): string[] {
  const body = withoutStepBodies(functionBody(stripComments(src), 'stopServer'))
  const bad: string[] = []
  for (const m of body.matchAll(/\bawait\s+/g)) {
    const rest = body.slice(m.index! + m[0].length)
    if (ALLOWED.some((a) => a.re.test(rest))) continue
    bad.push(rest.split('\n')[0]!.trim())
  }
  return bad
}

describe('stopServer waits only through bounded steps', () => {
  const src = fs.readFileSync(path.join(root, 'src/web/server.ts'), 'utf-8')

  it('has no await outside shutdownStep but the listed ones', () => {
    expect(unboundedWaits(src)).toEqual([])
  })

  it('starts the shared budget before its first wait', () => {
    const body = functionBody(stripComments(src), 'stopServer')
    expect(body.indexOf('beginShutdownSteps(')).toBeGreaterThanOrEqual(0)
    expect(body.indexOf('beginShutdownSteps(')).toBeLessThan(body.search(/\bawait\s/))
  })

  it('the scan finds a new unbounded wait (the 2026-11-12 importer stop, as it was)', () => {
    const before = `export async function stopServer(opts = {}) {
  beginShutdownSteps()
  await shutdownStep('fine', async () => { await slow() })
  if (externalSessionImporter) {
    try { await externalSessionImporter.stop() } catch { /* already logged */ }
  }
  const { x } = await import('./x.js')
  try { await closeHttpServer(httpServer, {}) } finally { httpServer = null }
}`
    const bad = unboundedWaits(before)
    expect(bad).toHaveLength(1)
    expect(bad[0]).toMatch(/^externalSessionImporter\.stop\(\)/)
  })
})
