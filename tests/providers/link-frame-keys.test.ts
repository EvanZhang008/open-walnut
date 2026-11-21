/**
 * A command frame on a daemon link is `{ id, cmd, ...params }` and its answer `{ id, ok, ...data }`:
 * a parameter or an answer field named like a frame key re-addresses the frame, and its answer never
 * reaches the caller (2026-11-21: `follower.triggers {id}` and the trigger answers' `id` timed out
 * every trigger call a host's server made while its leader was away). The class guard: the frame's
 * own keys always win on the daemon's answers (both twins), the follower link refuses a parameter
 * named like one, and no follower command a host's server sends names one.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FRAME_KEYS } from '../../src/host-server/daemon-link.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

function fnBody(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`)
  expect(at, `${name} exists`).toBeGreaterThan(-1)
  return src.slice(at, src.indexOf('\n}', at))
}

describe('link frames: a field never takes a frame key', () => {
  for (const twin of ['src/providers/daemon-standalone.ts', 'src/providers/daemon-source.ts']) {
    it(`${twin}: an answer's frame keys come after its data`, () => {
      const src = read(twin)
      expect(fnBody(src, 'sendOk')).toMatch(/\{\s*\.\.\.data,\s*id,\s*ok:\s*true\s*\}/)
      expect(fnBody(src, 'sendError')).toMatch(/\{\s*\.\.\.data,\s*id,\s*ok:\s*false/)
    })
  }

  it('the follower link refuses a parameter named like a frame key before it sends', () => {
    expect([...FRAME_KEYS]).toEqual(['id', 'cmd'])
    const call = fnBody(read('src/host-server/daemon-link.ts'), 'call')
    expect(call.indexOf('FRAME_KEYS')).toBeGreaterThan(-1)
    expect(call.indexOf('FRAME_KEYS')).toBeLessThan(call.indexOf('JSON.stringify({ id, cmd, ...params })'))
  })

  it('no follower command a host server sends names a frame key at its top level', () => {
    const dir = path.join(ROOT, 'src', 'replica')
    const bad: string[] = []
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8')
      const re = /\b(?:request|call)\(\s*'(follower\.[\w.]+)'\s*,\s*([^\n]*)/g
      for (let m = re.exec(src); m; m = re.exec(src)) {
        if (/^[^{]*\{\s*(?:id|cmd)\b/.test(m[2]!) || /\?\s*\{\s*(?:id|cmd)\b/.test(m[2]!)) bad.push(`${f}: ${m[1]} ${m[2]!.slice(0, 80)}`)
      }
    }
    expect(bad).toEqual([])
  })
})
