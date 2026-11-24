/**
 * A command frame on a daemon link is `{ id, cmd, ...params }` and its answer `{ id, ok, ...data }`:
 * a parameter or an answer field named like a frame key re-addresses the frame, and its answer never
 * reaches the caller (2026-11-21: `follower.triggers {id}` and the trigger answers' `id` timed out
 * every trigger call a host's server made while its leader was away). The class guard: the frame's
 * own keys always win on the daemon's answers, the follower link refuses a parameter
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
  it("the daemon: an answer's id comes after its data, and a refusal's ok:false in its data survives", () => {
    const src = read('src/providers/daemon-standalone.ts')
    // ok first (a refusal sent through sendOk with ok:false keeps it: 2026-11-21 review, R2-1), id last.
    // sendOk / sendError send the frames okFrame / errorFrame build (a direct call's reply is the same object).
    expect(fnBody(src, 'sendOk')).toMatch(/sendFrame\(ws, okFrame\(ws, id, data\)\)/)
    expect(fnBody(src, 'sendError')).toMatch(/sendFrame\(ws, errorFrame\(ws, id, error, data, level\)\)/)
    expect(fnBody(src, 'okFrame')).toMatch(/\{\s*ok:\s*true,\s*\.\.\.data,\s*id\s*\}/)
    expect(fnBody(src, 'errorFrame')).toMatch(/\{\s*\.\.\.data,\s*id,\s*ok:\s*false/)
    // The same object built the way the daemon builds it.
    const data: Record<string, unknown> = { ok: false, error: 'session_stopped', id: 'trigger-1' }
    const frame = { ok: true, ...data, id: 7 }
    expect(frame).toMatchObject({ ok: false, error: 'session_stopped', id: 7 })
  })

  it('the follower link refuses a parameter named like a frame key before it sends', () => {
    expect([...FRAME_KEYS]).toEqual(['id', 'cmd'])
    // One check both follower links take (the socket link's call, the direct link's ask).
    const pre = fnBody(read('src/host-server/daemon-link.ts'), 'preflightFrame')
    expect(pre.indexOf('FRAME_KEYS')).toBeGreaterThan(-1)
    expect(pre.indexOf('FRAME_KEYS')).toBeLessThan(pre.indexOf('JSON.stringify({ id, cmd, ...params })'))
    expect(fnBody(read('src/host-server/daemon-link.ts'), 'call')).toMatch(/socket\.send\(preflightFrame\(cmd, params, id\)\)/)
    expect(fnBody(read('src/core/link/follower-link-direct.ts'), 'ask')).toMatch(/preflightFrame\(cmd, params, 0\)/)
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
