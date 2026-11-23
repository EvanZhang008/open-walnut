/**
 * parseConfigMapping keeps the last text's mapping (src/core/config-file-io.ts): getConfig reads
 * config.yaml on every call, and its YAML parse was 1.9 s of a 30 s CPU profile on the live
 * server (2026-11-23). Each caller still gets its own copy: one that edits what it got never
 * changes what the next caller reads.
 */
import { describe, it, expect } from 'vitest'
import { parseConfigMapping } from '../../src/core/config-file-io.js'

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
