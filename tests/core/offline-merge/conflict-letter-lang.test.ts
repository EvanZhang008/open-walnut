/**
 * The offline-merge conflict letter in each letter language (src/core/human-inbox/walnut-letters/
 * offline-conflict.ts): Walnut's words follow the user's reply language, the values from the
 * conflict log (ids, field values, reasons, paths, host keys) and every link stay as given, the
 * 16 KB body cap holds in bytes for a long Chinese letter, and the send reads the language from
 * config. English stays the default.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-conflict-letter-lang'))
const state = vi.hoisted(() => ({ config: {} as Record<string, unknown>, letters: [] as Array<{ subject: string; markdown?: string }> }))
vi.mock('../../../src/core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/config-manager.js')>()),
  getConfig: async () => state.config,
}))
vi.mock('../../../src/core/human-inbox/store.js', () => ({
  sendLetter: async (input: { subject: string; markdown?: string }) => {
    state.letters.push(input)
    return { id: `letter-${state.letters.length}` }
  },
}))

import { buildConflictLetter, sendConflictLetter, LETTER_BODY_MAX } from '../../../src/core/offline-merge/letter.js'
import { OFFLINE_CONFLICT } from '../../../src/core/human-inbox/walnut-letters/offline-conflict.js'
import { ConflictLog, newDrainId, type ConflictEntry, type ConflictLogFile } from '../../../src/core/offline-merge/conflict-log.js'

const HAN = /[\u4e00-\u9fff]/

function file(entries: ConflictEntry[], hostKey = 'dev-box', drainId = 'd-lang-1'): ConflictLogFile {
  return { v: 2, drainId, hostKey, home: '/tmp/x', startedAt: '2026-11-02T00:00:00.000Z', entries }
}

const ENTRIES: ConflictEntry[] = [
  { kind: 'task-field', seq: 1, recordKind: 'task-fields', taskId: 'task-a', field: 'title', mac: 'Mac title', replica: 'Away title', kept: 'mac', why: 'both-changed' },
  { kind: 'task-field', seq: 2, recordKind: 'task-fields', taskId: 'task-b', field: 'project+group_id', mac: 'Acme', replica: 'Beta', kept: 'replica', why: 'invalid-pair' },
  { kind: 'task-field', seq: 3, recordKind: 'task-fields', taskId: 'task-c', field: 'due_date', mac: '2026-11-01', replica: '2026-11-02', kept: 'replica', why: 'both-changed' },
  { kind: 'refused', seq: 4, recordKind: 'op', taskId: 'task-d', reason: 'phase not allowed', bodiesLost: true },
  { kind: 'note', seq: 5, recordKind: 'note', notePath: 'Acme/plan.md', why: 'conflict', copyPath: 'Acme/plan (conflict).md' },
  { kind: 'board', seq: 6, recordKind: 'board', boardTaskId: 'task-e', reason: 'edit did not match' },
  { kind: 'conversation', seq: 7, recordKind: 'conversation-edit', kept: 'mac', mac: 'Old name', replica: '' },
]

const linksOf = (md: string): string[] => [...md.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1])

describe('the conflict letter in Chinese', () => {
  it('translates Walnut\'s words and keeps every value and link as given', () => {
    const en = buildConflictLetter(file(ENTRIES))!
    const zh = buildConflictLetter(file(ENTRIES), 'zh')!
    expect(zh.subject).toBe('你的 Mac 离线期间所做的 6 处改动未能顺利合并')
    expect(zh.markdown).toContain('有一些改动保存在主机 dev-box 上')
    expect(zh.markdown).toContain('[任务 task-a](/tasks/task-a)：title：保留了 Mac 上的值。Mac 上：“Mac title”；离线期间：“Away title”。')
    expect(zh.markdown).toContain('项目和文件夹：保留了离线期间的改动')
    expect(zh.markdown).toContain('Mac 拒绝了离线期间的一处改动：phase not allowed。它的内容已不在该主机上')
    expect(zh.markdown).toContain('[笔记 Acme/plan.md](/notes?path=Acme%2Fplan.md)：两边改了同样的几行')
    expect(zh.markdown).toContain('[task-e 的 Board](/tasks/task-e)')
    expect(zh.markdown).toContain('- 一个对话：两边都给它改了名，保留了 Mac 上的名字。Mac 上：“Old name”；离线期间：“（空）”。')
    expect(zh.markdown).toContain('另有 1 处任务设置的改动')
    expect(zh.markdown).toContain('[完整记录](/api/v1/offline-conflicts/d-lang-1#0)')
    expect(zh.markdown).not.toContain('Full entry')
    expect(zh.markdown).not.toMatch(/[–—]/)
    // The same links, items and counts as the English letter.
    expect(linksOf(zh.markdown)).toEqual(linksOf(en.markdown))
    expect({ ...zh, subject: '', markdown: '' }).toEqual({ ...en, subject: '', markdown: '' })
    expect(HAN.test(en.subject + en.markdown)).toBe(false)
  })

  it('the companion reads as such', () => {
    expect(buildConflictLetter(file(ENTRIES, 'companion'), 'zh')!.markdown).toContain('保存在你的云端伴侣上')
    expect(buildConflictLetter(file(ENTRIES, 'companion'))!.markdown).toContain('your cloud companion saved changes')
  })

  it('a long Chinese letter stays under the byte cap and counts the rest', () => {
    const words = (n: number): ConflictEntry => ({ kind: 'task-field', seq: n, recordKind: 'task-fields', taskId: `task-${n}`, field: 'title', mac: `标题${'长'.repeat(200)}${n}`, replica: `离开${'远'.repeat(200)}${n}`, kept: 'mac', why: 'both-changed' })
    const setting = (n: number): ConflictEntry => ({ kind: 'task-field', seq: n, recordKind: 'task-fields', taskId: `task-${n}`, field: 'priority', mac: 'high', replica: 'low', kept: 'replica', why: 'both-changed' })
    const drainId = newDrainId('h'.repeat(64))
    const entries = Array.from({ length: 3000 }, (_, i) => (i % 3 === 0 ? setting(i) : words(i)))
    const zh = buildConflictLetter(file(entries, 'h'.repeat(64), drainId), 'zh')!
    expect(Buffer.byteLength(zh.markdown)).toBeLessThanOrEqual(LETTER_BODY_MAX)
    expect(zh).toMatchObject({ needed: 2000, settled: 1000 })
    expect(zh.listed).toBeGreaterThan(0)
    expect(zh.listed).toBeLessThan(2000)
    expect(zh.markdown).toContain(`还有 ${2000 - zh.listed} 项在[完整列表](/api/v1/offline-conflicts/${drainId})里。`)
    expect(zh.markdown).toContain('另有 1000 处任务设置的改动')
    // Values are cut at the same 160 characters in either language.
    expect(zh.markdown).toContain(`“标题${'长'.repeat(158)}...”`)
  })

  it('the kind renders the same letter, in every language, for its samples', () => {
    for (const sample of OFFLINE_CONFLICT.samples) {
      for (const lang of ['en', 'zh'] as const) {
        const built = buildConflictLetter(sample, lang)!
        expect(OFFLINE_CONFLICT.render(lang, sample)).toEqual({ subject: built.subject, markdown: built.markdown })
      }
      expect(HAN.test(OFFLINE_CONFLICT.render('en', sample).markdown)).toBe(false)
      expect(HAN.test(OFFLINE_CONFLICT.render('zh', sample).markdown)).toBe(true)
    }
  })
})

describe('the send reads the letter language from config', () => {
  beforeEach(() => { state.letters = [] })

  const logWith = (hostKey: string): ConflictLog => {
    const l = new ConflictLog(hostKey, '/tmp/x')
    for (const e of ENTRIES) l.data.entries.push(e)
    return l
  }

  it('English with no language set', async () => {
    state.config = {}
    expect(await sendConflictLetter(logWith('host-en'))).toBe(true)
    expect(state.letters[0].subject).toBe('6 changes made while your Mac was away did not merge cleanly')
  })

  it('Chinese when the reply language is Chinese', async () => {
    state.config = { session: { reply_language: 'Reply in Simplified Chinese' } }
    expect(await sendConflictLetter(logWith('host-zh'))).toBe(true)
    expect(state.letters[0].subject).toBe('你的 Mac 离线期间所做的 6 处改动未能顺利合并')
    expect(state.letters[0].markdown).toContain('主机 host-zh 上')
  })
})
