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
  stat: new Map<string, { ok: boolean; exists?: boolean }>(),
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
      return { ok: false, error: 'unexpected' }
    },
  }),
}))
vi.mock('../../src/core/config-manager.js', () => ({ getConfig: async () => ({}) }))

import { DaemonFileReader } from '../../src/core/daemon-file-reader.js'

const SID = '8b6dc196-0000-4000-8000-000000000001'
const CWD = '/home/me/repo'
const ROOT = '~/.claude/projects'
const OWN = `${ROOT}/-home-me-repo/${SID}.jsonl`
const probe = () => new DaemonFileReader('clouddev').probeSessionPath(SID, CWD, 1_000)

beforeEach(() => {
  wire.stat.clear()
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
