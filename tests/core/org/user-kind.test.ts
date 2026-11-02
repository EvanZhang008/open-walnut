/**
 * Which of the user's own kinds a question is (src/core/org/user-kind.ts), and where Walnut asks:
 * a Thread an agent hands to the user (threads-model.ts). The letter path is in
 * tests/e2e/org-threads.test.ts (the server, real routes).
 */
import { describe, it, expect } from 'vitest'
import { USER_KINDS, USER_KIND_WORDS, userKindVerdict, userKindLead } from '../../../src/core/org/user-kind.js'
import { emptyThreads, openThread, updateThread, ThreadError, type ThreadsFile } from '../../../src/core/org/threads-model.js'

const AT = '2026-11-01T10:00:00.000Z'
const WHY = 'It posts to a public channel as them'

describe('userKindVerdict', () => {
  it('takes every listed kind with a reason, in either spelling of the keys', () => {
    for (const kind of USER_KINDS) {
      expect(userKindVerdict({ user_kind: kind, user_kind_why: WHY })).toEqual({ ok: true, kind, why: WHY })
      expect(userKindVerdict({ userKind: kind, userKindWhy: WHY })).toMatchObject({ ok: true, kind })
    }
    expect(USER_KINDS.every((k) => !!USER_KIND_WORDS[k])).toBe(true)
  })

  it('refuses a missing kind, a missing or short reason, and a kind that is not listed, naming the never-his list', () => {
    for (const input of [{}, { user_kind: 'outward' }, { user_kind: 'outward', user_kind_why: 'too short' }, { user_kind_why: WHY },
      { user_kind: 'convenience', user_kind_why: WHY }, { user_kind: 7, user_kind_why: WHY }]) {
      const v = userKindVerdict(input as never)
      expect(v.ok).toBe(false)
      if (v.ok) continue
      expect(v.message).toContain('user_kind')
      expect(v.message).toContain('undoing something an agent broke or changed')
      expect(v.message).toContain('If none of the kinds fits, it is yours to decide')
    }
  })

  it('a reason is measured after whitespace is squeezed', () => {
    expect(userKindVerdict({ user_kind: 'outward', user_kind_why: '   a   b   ' }).ok).toBe(false)
  })

  it('leads a letter with the kind in plain words', () => {
    const v = userKindVerdict({ user_kind: 'cloud_delete', user_kind_why: WHY })
    if (!v.ok) throw new Error('expected ok')
    expect(userKindLead(v)).toBe(`Yours to decide (deleting cloud resources or data): ${WHY}`)
  })

  it('is plain ASCII English with no dash punctuation', () => {
    const all = [...Object.values(USER_KIND_WORDS), (userKindVerdict({}) as { message: string }).message].join('\n')
    expect(all).not.toMatch(/[\u2013\u2014]/)
    expect(all).toMatch(/^[\x20-\x7e\n]+$/)
  })
})

describe('Threads an agent hands to the user', () => {
  const file = (): ThreadsFile => emptyThreads('lead-1')
  const opened = (state?: 'needs' | 'answered', by: 'human' | 'agent' | `task:${string}` = 'task:lead-1', extra: Record<string, unknown> = {}) =>
    openThread(file(), { title: 'Reinstall?', text: 'A test overwrote it', from: 'node', ...(state ? { state } : {}), ...extra }, by, AT)

  it('opening one that waits on the user (the default) needs a kind; answered does not', () => {
    expect(() => opened()).toThrow(ThreadError)
    expect(() => opened('needs')).toThrow(/user_kind/)
    try { opened() } catch (e) { expect((e as ThreadError)).toMatchObject({ code: 'user_kind', status: 409 }) }
    expect(opened('answered').thread.state).toBe('answered')
    const ok = opened(undefined, 'task:lead-1', { user_kind: 'user_own', user_kind_why: 'It is his mail and his calendar' })
    expect(ok.thread.state).toBe('needs')
    expect(JSON.stringify(ok.thread)).not.toContain('user_kind')
  })

  it('moving a thread to needs needs a kind, unless it already waits on the user or the user moves it', () => {
    const { file: f, thread } = opened('answered')
    expect(() => updateThread(f, thread.id, { state: 'needs' }, 'task:lead-1', AT)).toThrow(/user_kind/)
    expect(() => updateThread(f, thread.id, { state: 'needs' }, 'agent', AT)).toThrow(/user_kind/)
    const moved = updateThread(f, thread.id, { state: 'needs', user_kind: 'spending', user_kind_why: 'It buys a paid plan' }, 'task:lead-1', AT)
    expect(moved.thread.state).toBe('needs')
    // Already waiting: a new summary with state needs again is not a new hand-over.
    expect(updateThread(moved.file, thread.id, { state: 'needs', reply: 'Still open' }, 'task:lead-1', AT).thread.reply).toBe('Still open')
    // Other changes never ask.
    expect(updateThread(f, thread.id, { reply: 'Done' }, 'task:lead-1', AT).thread.reply).toBe('Done')
    expect(updateThread(f, thread.id, { title: 'New title' }, 'task:lead-1', AT).thread.title).toBe('New title')
    // A closed thread reopened into needs is a hand-over too.
    const closed = updateThread(moved.file, thread.id, { close: 'dropped' }, 'task:lead-1', AT)
    expect(() => updateThread(closed.file, thread.id, { reopen: true }, 'task:lead-1', AT)).toThrow(/user_kind/)
    expect(updateThread(closed.file, thread.id, { reopen: true, user_kind: 'spending', user_kind_why: 'It buys a paid plan' }, 'task:lead-1', AT).thread.closed).toBeUndefined()
    // The user's own change is never asked.
    expect(updateThread(f, thread.id, { state: 'needs' }, 'human', AT).thread.state).toBe('needs')
  })
})
