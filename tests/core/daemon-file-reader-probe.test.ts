/**
 * DaemonFileReader.probeSessionPath: is a conversation proven never written on its
 * host? Only then does a resume start fresh under the same id (claude-code-session.ts).
 *
 * 2026-11-05 review: a find skips symlinked and unreadable folders and still answers
 * ok, so an empty find alone proves nothing. Proven absent needs every root to
 * exist, the transcript's own path (through any symlink) to be ENOENT, and the
 * find to hold no copy; anything that fails or cannot be told is unknown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const wire = vi.hoisted(() => ({
  stat: new Map<string, { ok: boolean; exists?: boolean; size?: number }>(),
  read: new Map<string, { ok: boolean; data?: string; error?: string }>(),
  find: { ok: true, files: [] as string[] } as { ok: boolean; files?: string[] },
  asked: [] as string[],
}))

vi.mock('../../src/core/hosts/link.js', () => ({
  linkTarget: () => ({}),
  link: async () => ({
    send: async (cmd: string, args: Record<string, unknown>) => {
      wire.asked.push(`${cmd} ${String(args.path)}`)
      if (cmd === 'fs.stat') return wire.stat.get(String(args.path)) ?? { ok: true, exists: false }
      if (cmd === 'fs.find') return wire.find
      if (cmd === 'fs.read') return wire.read.get(String(args.path)) ?? { ok: false, error: 'ENOENT' }
      return { ok: false, error: 'unexpected' }
    },
  }),
}))
vi.mock('../../src/core/config-manager.js', () => ({ getConfig: async () => ({}) }))

import { DaemonFileReader, streamTextHeldConversation } from '../../src/core/daemon-file-reader.js'

const SID = '8b6dc196-0000-4000-8000-000000000001'
const CWD = '/home/me/repo'
const ROOT = '~/.claude/projects'
const OWN = `${ROOT}/-home-me-repo/${SID}.jsonl`
const probe = () => new DaemonFileReader('clouddev').probeSessionPath(SID, CWD, 1_000)

beforeEach(() => {
  wire.stat.clear()
  wire.read.clear()
  wire.stat.set(ROOT, { ok: true, exists: true })
  wire.find = { ok: true, files: [] }
  wire.asked = []
})

describe('probeSessionPath', () => {
  it('proven absent: the root exists, its own path is ENOENT, and the find holds no copy', async () => {
    expect(await probe()).toBeNull()
    expect(wire.asked).toEqual([`fs.stat ${ROOT}`, `fs.stat ${OWN}`, `fs.find ${ROOT}`])
  })

  it('its own path exists (a symlinked project folder the find would skip): found', async () => {
    wire.stat.set(OWN, { ok: true, exists: true })
    expect(await probe()).toBe(OWN)
  })

  it('a copy elsewhere under the root: found', async () => {
    wire.find = { ok: true, files: [`${ROOT}/-old-cwd/${SID}.jsonl`] }
    expect(await probe()).toBe(`${ROOT}/-old-cwd/${SID}.jsonl`)
  })

  it.each([
    ['the root is missing (a host reinstalled)', () => { wire.stat.set(ROOT, { ok: true, exists: false }) }],
    ['the root cannot be stat-ed', () => { wire.stat.set(ROOT, { ok: false }) }],
    ['its own path cannot be stat-ed (EMFILE, EACCES)', () => { wire.stat.set(OWN, { ok: false }) }],
    ['the find failed', () => { wire.find = { ok: false } }],
  ])('unknown when %s', async (_label, prep) => {
    prep()
    expect(await probe()).toBeUndefined()
  })

  it('unknown for a cwd whose folder name carries a hash this side cannot compute', async () => {
    expect(await new DaemonFileReader('clouddev').probeSessionPath(SID, '/x/' + 'a'.repeat(260), 1_000)).toBeUndefined()
  })
})

/**
 * A transcript the probe cannot find proves nothing about a session whose own stream
 * answered: only a stream with no answer of the CLI's (or none at all) lets the resume
 * start fresh, because a fresh start empties that stream (2026-11-06: a side thread's
 * follow-up started fresh and its first answer was wiped from its history).
 */
describe('streamHeldConversation', () => {
  const PRIMARY = `~/.open-walnut/tmp/streams/${SID}.jsonl`
  const LEGACY = `/tmp/open-walnut-streams/${SID}.jsonl`
  const held = () => new DaemonFileReader('clouddev').streamHeldConversation([PRIMARY, LEGACY], 1_000)
  const put = (p: string, lines: unknown[]) => {
    const data = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
    wire.stat.set(p, { ok: true, exists: true, size: data.length })
    wire.read.set(p, { ok: true, data })
  }
  const BOOT = [
    { type: 'walnut_process', pid: 1, walnutTurn: true },
    { type: 'user', message: { role: 'user', content: 'hello "type":"result"' } },
  ]

  it('a stream with an answer ran: true', async () => {
    put(PRIMARY, [...BOOT, { type: 'system', subtype: 'init' }, { type: 'assistant', message: {} }, { type: 'result', subtype: 'success' }])
    expect(await held()).toBe(true)
  })

  it('an answer in the legacy stream counts too', async () => {
    put(PRIMARY, BOOT)
    put(LEGACY, [{ type: 'result', subtype: 'success', is_error: false }])
    expect(await held()).toBe(true)
  })

  it('a boot that died before its first answer (its line quoting a result inside a string): false', async () => {
    put(PRIMARY, [...BOOT, { type: 'system', subtype: 'init' }])
    expect(await held()).toBe(false)
  })

  it('a resume refused with No conversation found is no answer: false', async () => {
    put(PRIMARY, [...BOOT, { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [`No conversation found with session ID: ${SID}`] }])
    expect(await held()).toBe(false)
  })

  it('no stream at all (a start that never reached its host): false', async () => {
    expect(await held()).toBe(false)
  })

  it.each([
    ['a stat fails', () => { wire.stat.set(PRIMARY, { ok: false }) }],
    ['a read fails', () => { wire.stat.set(PRIMARY, { ok: true, exists: true, size: 10 }) }],
    ['the stream is too large to read here', () => { wire.stat.set(PRIMARY, { ok: true, exists: true, size: 64 * 1024 * 1024 }) }],
  ])('unknown when %s', async (_label, prep) => {
    prep()
    expect(await held()).toBeUndefined()
  })

  it('a torn line never throws', () => {
    expect(streamTextHeldConversation('{"type":"assistant"')).toBe(false)
  })
})
