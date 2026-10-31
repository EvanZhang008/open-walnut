/**
 * redact (src/core/hosts/host-exec.ts): what host_exec hides from a command's
 * output before it leaves the server. Past the scanner's 20 findings every
 * token still goes, a private key goes from BEGIN to END (or to the end of a
 * cut-off output), and a window that starts inside a key goes up to its END.
 */
import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { redact } from '../../../src/core/hosts/host-exec.js'

const token = () => `ghp_${randomBytes(30).toString('base64').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 36)}`
const body = () => randomBytes(48).toString('base64')
const HID = /^\[Walnut hid this line/
// Key armour built from parts, so a secret scanner never reads a key header in this file.
const DASH = '-'.repeat(5)
const armour = (edge: 'BEGIN' | 'END', kind: string) => `${DASH}${edge} ${kind} PRIVATE KEY${DASH}`

describe('host_exec redaction', () => {
  it('hides every token past the scanner cap', async () => {
    const tokens = Array.from({ length: 45 }, token)
    const text = ['start', ...tokens.map((t) => `t=${t}`), 'end', ''].join('\n')
    const r = await redact(text)
    for (const t of tokens) expect(r.text).not.toContain(t)
    expect(r.redacted).toBe(45)
    expect(r.text.startsWith('start\n')).toBe(true)
    expect(r.text.endsWith('\nend\n')).toBe(true)
  })

  it('hides a key from BEGIN to END, and keeps what follows', async () => {
    const b = body()
    const r = await redact(['a', armour('BEGIN', 'RSA'), b, b, armour('END', 'RSA'), 'z', ''].join('\n'))
    const lines = r.text.split('\n')
    expect(lines[0]).toBe('a')
    expect(lines.slice(1, 5).every((l) => HID.test(l))).toBe(true)
    expect(lines[5]).toBe('z')
    expect(r.text).not.toContain(b)
  })

  it('hides up to the END when the window starts inside a key', async () => {
    const b = body()
    const r = await redact([b, b, armour('END', 'OPENSSH'), 'after', ''].join('\n'))
    expect(r.text).not.toContain(b)
    expect(r.text.split('\n')[3]).toBe('after')
    expect(r.redacted).toBe(3)
  })

  it('leaves ordinary output alone', async () => {
    expect(await redact('build ok\n2 warnings\n')).toEqual({ text: 'build ok\n2 warnings\n', redacted: 0 })
  })
})
