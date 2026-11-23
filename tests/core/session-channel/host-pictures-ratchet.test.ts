/**
 * Ratchet for land 8: the phone's pictures reach a session its host judges while the Mac is away,
 * the way they reach a session on another machine on every other path (saved on the host by its
 * daemon's `image.save`, named under the images header: sessions/cloud-images.ts). The regression
 * this guards: land 5b answered such pictures 409 `images_need_mac` on the host path, where the
 * legacy path had always carried them.
 *
 * Enumerated from the source: every file that routes a phone operation through a host's link
 * (calls `hostRoute(`), and companion-host-ops.ts itself, refuses no picture with that code; and
 * each call that hands the host a person's words hands it their pictures too.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')

function walk(dir: string): string[] {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return []
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) return walk(rel)
    return /\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [rel] : []
  })
}

/** Code without comments, so a comment naming the old code is no refusal. */
const code = (file: string): string =>
  fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** The argument text of every call `name(...)` in `text`, parentheses balanced. */
function callArgs(text: string, name: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(new RegExp(`\\b${name}\\(`, 'g'))) {
    const from = (m.index ?? 0) + m[0].length
    let depth = 1
    let at = from
    for (; at < text.length && depth > 0; at++) depth += text[at] === '(' ? 1 : text[at] === ')' ? -1 : 0
    out.push(text.slice(from, at - 1))
  }
  return out
}

const HOST_OPS = 'src/core/session-channel/companion-host-ops.ts'
const routed = walk('src').filter((f) => f !== HOST_OPS && /\bhostRoute\(/.test(code(f))).sort()

describe('pictures for a host-judged session are carried, never refused for wanting the Mac', () => {
  it('finds the phone routes that go through a host\'s link', () => {
    // A new route here is checked by the tests below as it is; this list only says the scan works.
    expect(routed).toEqual(expect.arrayContaining(['src/web/routes/cloud-session-send.ts', 'src/web/routes/session-lifecycle-v1.ts']))
  })

  it('no such route, and not companion-host-ops.ts, answers images_need_mac', () => {
    const refusing = [HOST_OPS, ...routed].filter((f) => /images_need_mac|IMAGES_NEED_MAC/.test(code(f)))
    expect(refusing, 'carry the pictures to the host (companion-host-ops.ts picturesOnHost) instead of refusing them').toEqual([])
  })

  it('each send through the host hands it the pictures, and each answer the body that holds them', () => {
    const calls = routed.flatMap((f) => callArgs(code(f), 'sendViaHost').map((a) => [f, a] as const))
    expect(calls.length).toBeGreaterThan(0)
    for (const [f, args] of calls) expect(args, `${f}: sendViaHost(${args})`).toMatch(/\bimages\b/)
    // The scan reads a whole argument list, nested calls included (review round 1, N4).
    expect(callArgs('f(a, g(b), { c: h(d, e) })', 'f')).toEqual(['a, g(b), { c: h(d, e) }'])
    const answers = routed.flatMap((f) => callArgs(code(f), 'permissionViaHost').map((a) => [f, a] as const))
    expect(answers.length).toBeGreaterThan(0)
    for (const [f, args] of answers) expect(args, `${f}: permissionViaHost(${args})`).toMatch(/\bbody\b/)
  })

  it('companion-host-ops.ts saves pictures by the one shared loop, before the words go', () => {
    const text = code(HOST_OPS)
    expect(text).toMatch(/\bsaveImagesViaBridge\(/)
    expect(text.indexOf('picturesOnHost(t, o.images)')).toBeGreaterThan(-1)
    expect(text.indexOf('picturesOnHost(t, o.images)')).toBeLessThan(text.indexOf("'/host-api/sessions/send'"))
  })
})
