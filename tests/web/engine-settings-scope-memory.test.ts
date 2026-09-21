/**
 * The write-scope memory of the engine settings popover
 * (web/src/components/sessions/engine-settings-scope-memory.ts), pure half:
 * which scope the FIRST request asks for, and the storage key it reads
 * (per engine + host + cwd, so a Codex session never inherits a Claude Code
 * memory for the same directory).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { rememberedScope } from '../../web/src/components/sessions/engine-settings-scope-memory'
import { scopeStorageKey } from '../../web/src/utils/engine-settings-copy'

type StorageLike = { getItem(key: string): string | null }
const g = globalThis as unknown as { localStorage?: StorageLike }
const original = g.localStorage

function fakeStorage(entries: Record<string, string>): StorageLike {
  return { getItem: (key) => (key in entries ? entries[key] : null) }
}

afterEach(() => {
  if (original === undefined) delete g.localStorage
  else g.localStorage = original
})

describe('rememberedScope', () => {
  const key = scopeStorageKey('__local__', '/work/app', 'claude')

  it('asks for the remembered project scope on the first request when the cwd is known', () => {
    g.localStorage = fakeStorage({ [key]: 'project' })
    expect(rememberedScope(key, '/work/app')).toBe('project')
  })

  it('never starts on project without a cwd, whatever is remembered', () => {
    g.localStorage = fakeStorage({ [key]: 'project' })
    expect(rememberedScope(key, undefined)).toBe('default')
    expect(rememberedScope(key, '')).toBe('default')
  })

  it('anything but "project" (nothing remembered, a junk value) is the default', () => {
    g.localStorage = fakeStorage({})
    expect(rememberedScope(key, '/work/app')).toBe('default')
    g.localStorage = fakeStorage({ [key]: 'weird' })
    expect(rememberedScope(key, '/work/app')).toBe('default')
  })

  it('a memory for another engine in the same directory is not read', () => {
    g.localStorage = fakeStorage({ [scopeStorageKey('__local__', '/work/app', 'claude')]: 'project' })
    expect(rememberedScope(scopeStorageKey('__local__', '/work/app', 'codex'), '/work/app')).toBe('default')
  })

  it('storage that throws (private mode) reads as the default', () => {
    g.localStorage = { getItem: () => { throw new Error('denied') } }
    expect(rememberedScope(key, '/work/app')).toBe('default')
    delete g.localStorage
    expect(rememberedScope(key, '/work/app')).toBe('default')
  })
})
