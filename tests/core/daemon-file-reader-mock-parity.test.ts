/**
 * The shared test double of DaemonFileReader (tests/helpers/mock-local-daemon-reader.ts) has
 * every method and export of the real one.
 *
 * 2026-11-06: the resume path started calling `probeSessionPath`, which the double lacked. Its
 * caller caught the TypeError, so no test failed on it; instead every resume spawn through the
 * double failed, left the session record `running`, and the Org Threads e2e ran on a state
 * production never has. A method the double cannot serve is named in its NOT_SERVED list (and
 * throws an error saying so); anything else is served. This test fails on a new method or export
 * of the real reader the double does not have, and on a stale NOT_SERVED entry.
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-reader-mock-parity'))

import { CLAUDE_HOME } from '../../src/constants.js'
import * as real from '../../src/core/daemon-file-reader.js'
import { encodeProjectPath } from '../../src/core/session-file-reader.js'
import { mockLocalDaemonReader, NOT_SERVED } from '../helpers/mock-local-daemon-reader.js'

const SOURCE = fileURLToPath(new URL('../../src/core/daemon-file-reader.ts', import.meta.url))

/** Members the real class declares `private` (TypeScript keeps them on the class at runtime). */
async function privateMembers(): Promise<Set<string>> {
  const text = await fs.readFile(SOURCE, 'utf8')
  const names = [...text.matchAll(/^\s+private\s+(?:static\s+)?(?:readonly\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])
  return new Set(names)
}

function ownNames(o: object, skip: readonly string[]): string[] {
  return Object.getOwnPropertyNames(o).filter((n) => !skip.includes(n))
}

describe('the shared DaemonFileReader double matches the real reader', () => {
  it('has every public method and static of the real class', async () => {
    const hidden = await privateMembers()
    // The parse found the private members it must (a source change that breaks it fails here).
    expect(hidden.has('resolve')).toBe(true)
    const Real = real.DaemonFileReader
    const Mock = mockLocalDaemonReader().DaemonFileReader as unknown as typeof Real
    const methods = ownNames(Real.prototype, ['constructor']).filter((n) => !hidden.has(n))
    expect(methods.length).toBeGreaterThan(20)
    const missing = methods.filter((n) => typeof (Mock.prototype as unknown as Record<string, unknown>)[n] !== 'function')
    expect(missing, 'methods of DaemonFileReader the double lacks: serve them, or name them in NOT_SERVED').toEqual([])
    const statics = ownNames(Real, ['length', 'name', 'prototype']).filter((n) => !hidden.has(n))
    expect(statics.filter((n) => typeof (Mock as unknown as Record<string, unknown>)[n] !== typeof (Real as unknown as Record<string, unknown>)[n])).toEqual([])
  })

  it('names in NOT_SERVED only methods the real class has', async () => {
    const hidden = await privateMembers()
    const methods = new Set(ownNames(real.DaemonFileReader.prototype, ['constructor']).filter((n) => !hidden.has(n)))
    expect(NOT_SERVED.filter((n) => !methods.has(n))).toEqual([])
    const reader = new (mockLocalDaemonReader().DaemonFileReader)('__local__') as unknown as Record<string, () => Promise<unknown>>
    await expect(reader[NOT_SERVED[0]]()).rejects.toThrow(`does not serve ${NOT_SERVED[0]}`)
  })

  it('exports what the real module exports, the non-class values being the same ones', () => {
    const mocked = mockLocalDaemonReader() as Record<string, unknown>
    expect(Object.keys(mocked).sort()).toEqual(Object.keys(real).sort())
    for (const key of Object.keys(real)) {
      if (key === 'DaemonFileReader') continue
      expect(mocked[key], key).toBe((real as Record<string, unknown>)[key])
    }
  })

  it('answers probeSessionPath and streamHeldConversation the way the real reader does', async () => {
    const reader = new (mockLocalDaemonReader().DaemonFileReader)('__local__')
    const sid = '11111111-2222-4333-8444-555555555555'
    const cwd = '/tmp/parity-project'
    // No transcripts root yet: nothing can be proven.
    await fs.rm(path.join(CLAUDE_HOME, 'projects'), { recursive: true, force: true })
    expect(await reader.probeSessionPath(sid, cwd)).toBeUndefined()
    // The root exists and holds no copy: proven absent.
    await fs.mkdir(path.join(CLAUDE_HOME, 'projects'), { recursive: true })
    expect(await reader.probeSessionPath(sid, cwd)).toBeNull()
    // At its own path, and as a copy under another project folder.
    const own = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(cwd), `${sid}.jsonl`)
    await fs.mkdir(path.dirname(own), { recursive: true })
    await fs.writeFile(own, '{}\n')
    expect(await reader.probeSessionPath(sid, cwd)).toBe(own)
    expect(await reader.probeSessionPath(sid, '/tmp/elsewhere')).toBe(own)

    const stream = path.join(CLAUDE_HOME, 'stream.jsonl')
    expect(await reader.streamHeldConversation([stream])).toBe(false)
    await fs.writeFile(stream, JSON.stringify({ type: 'assistant', message: {} }) + '\n')
    expect(await reader.streamHeldConversation([stream])).toBe(true)
  })
})
