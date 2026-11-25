/**
 * parseConfigMapping keeps the last text's mapping (src/core/config-file-io.ts): getConfig reads
 * config.yaml on every call, and its YAML parse was 1.9 s of a 30 s CPU profile on the live
 * server (2026-11-23). Each caller still gets its own copy: one that edits what it got never
 * changes what the next caller reads.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import yaml from 'js-yaml'
import { cloneYamlData, parseConfigMapping } from '../../src/core/config-file-io.js'

/** A config shaped like the live one: about 20 KB, 45 sections of nested mappings and lists. */
function realisticConfigText(): string {
  const doc: Record<string, unknown> = { version: 1 }
  for (let s = 0; s < 45; s++) {
    const sec: Record<string, unknown> = {}
    for (let k = 0; k < 6; k++) {
      sec[`key_${k}`] = k % 3 === 0
        ? { a: `value-${s}-${k}-xxxxxxxxxxxx`, b: s * k, c: true, list: [`x${k}`, `y${k}`, `zzzz${k}`] }
        : `string value number ${s} ${k} abcdefghij`
    }
    doc[`section_${s}`] = sec
  }
  return yaml.dump(doc)
}

describe('parseConfigMapping keeps the last mapping', () => {
  it('the same text gives an equal mapping that is a separate copy', () => {
    const text = 'hosts:\n  a:\n    hostname: one\nlist:\n  - x\n'
    const first = parseConfigMapping(text).doc!
    ;((first.hosts as Record<string, { hostname: string }>).a).hostname = 'edited'
    ;(first.list as string[]).push('y')
    const second = parseConfigMapping(text).doc!
    expect(second).toEqual({ hosts: { a: { hostname: 'one' } }, list: ['x'] })
    const third = parseConfigMapping(text).doc!
    expect(third).not.toBe(second)
    expect(third.hosts).not.toBe(second.hosts)
  })

  it('new text is parsed again, and a bad text still says why', () => {
    expect(parseConfigMapping('a: 1\n').doc).toEqual({ a: 1 })
    expect(parseConfigMapping('a: 2\n').doc).toEqual({ a: 2 })
    expect(parseConfigMapping('- just\n- a list\n')).toEqual({ doc: null, error: 'not a YAML mapping' })
    expect(parseConfigMapping('a: [\n').doc).toBeNull()
  })
})

// getConfig runs some 20 times a second on the live server, and each answer is a copy of the kept
// mapping: Bun's structuredClone of a 24 KB config costs about 250 us, nine times a plain walk
// (2026-11-25 stall profiles: 8.9 s of 395 s of loop CPU in stall windows was that one clone).
describe('the kept mapping is copied by a plain walk', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('a read of unchanged text never calls structuredClone', () => {
    const text = realisticConfigText()
    expect(text.length).toBeGreaterThan(15_000)
    parseConfigMapping(text)
    const spy = vi.spyOn(globalThis, 'structuredClone')
    for (let i = 0; i < 20; i++) parseConfigMapping(text)
    expect(spy).not.toHaveBeenCalled()
  })

  it('the copy keeps what YAML loads: timestamps, a __proto__ key, binary, nesting', () => {
    const text = 'at: 2026-11-25T10:00:00Z\n__proto__:\n  polluted: yes\nbin: !!binary aGVsbG8=\nlist:\n  - a: 1\n'
    const first = parseConfigMapping(text).doc!
    const second = parseConfigMapping(text).doc!
    expect(second.at).toBeInstanceOf(Date)
    expect((second.at as Date).toISOString()).toBe('2026-11-25T10:00:00.000Z')
    expect(second.at).not.toBe(first.at)
    expect(Object.getPrototypeOf(second)).toBe(Object.prototype)
    expect(Object.keys(second)).toContain('__proto__')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Buffer.from(second.bin as Uint8Array).toString()).toBe('hello')
    expect(second.list).toEqual([{ a: 1 }])
    expect((second.list as unknown[])[0]).not.toBe((first.list as unknown[])[0])
  })

  // structuredClone kept both, so the plain walk must too: a self-naming anchor overflowed the
  // stack (the file read as unparseable, which starts the repair path), and an alias bomb was
  // expanded on every copy.
  it('an anchor that names itself stays a cycle, read after read', () => {
    const text = 'a: &x\n  b: *x\n  c: 1\n'
    const first = parseConfigMapping(text)
    expect(first.error).toBeUndefined()
    const second = parseConfigMapping(text).doc!
    const a = second.a as Record<string, unknown>
    expect(a.b).toBe(a)
    expect(a.c).toBe(1)
    expect(a).not.toBe(first.doc!.a)
    expect(structuredClone(second).a).toMatchObject({ c: 1 })
  })

  it('an alias stays one shared object, so an alias bomb is never expanded', () => {
    const levels = ['a: &a [x, x, x, x, x, x, x, x, x]']
    for (let i = 1; i < 9; i++) {
      const prev = String.fromCharCode(96 + i)
      levels.push(`${String.fromCharCode(97 + i)}: &${String.fromCharCode(97 + i)} [${Array(9).fill(`*${prev}`).join(', ')}]`)
    }
    const text = levels.join('\n') + '\n'
    parseConfigMapping(text)
    const started = performance.now()
    const doc = parseConfigMapping(text).doc!
    expect(performance.now() - started).toBeLessThan(50)
    const top = doc.i as unknown[]
    expect(top[0]).toBe(top[8])
    expect((top[0] as unknown[])[0]).toBe(doc.g)
  })

  it('cloneYamlData leaves scalars as they are', () => {
    expect(cloneYamlData(null)).toBeNull()
    expect(cloneYamlData(3)).toBe(3)
    expect(cloneYamlData('x')).toBe('x')
  })
})
