/**
 * A post-compaction hook statement counts only for a compaction of the session's own
 * conversation (src/core/sessions/hook-statement.ts).
 *
 * 2026-10-30: a lead's turn-end report runs as a side question, a fork of its conversation. The
 * fork compacted, its SessionStart hook called open_items hook:"compact" with the lead's session
 * id, and the server recorded every changed default instruction (a new rule included) as told to
 * the lead's main conversation, which never compacted and never read them. The same record shape
 * holds the told place and the told message hints, so the guard covers the class: every source
 * file that writes a hook statement must also apply hookStatementVoid when it reads one back.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { HOOK_BOUNDARY_MS, hookStatementVoid } from '../../../src/core/sessions/hook-statement.js'
import { instructionNoticeFor } from '../../../src/core/sessions/instruction-notice.js'
import { LEAD_NEWS_ONCE_LINE, WALNUT_PROMPT_MARK, defaultInstructions } from '../../../src/core/sessions/session-context.js'
import { promptHash as placePromptHash, toldPlaceOf } from '../../../src/core/sessions/place-notice.js'
import { effectiveHints } from '../../../src/core/hints/hint-registry.js'
import { advanceHintState, planHints } from '../../../src/core/hints/hint-send.js'
import type { Config, SessionHintState } from '../../../src/core/types.js'

const hookAt = Date.parse('2026-10-30T15:22:05Z')
const iso = (ms: number) => new Date(ms).toISOString()
/** The lead's last real compaction, hours before its turn-end report compacted. */
const longBefore = iso(hookAt - 3 * 3600_000)
/** What notePlaceCompaction writes when the boundary the hook answered is read. */
const carried = iso(hookAt + 2_000)

describe('hookStatementVoid', () => {
  it('a statement no boundary came near is void; one read near it, on either side, stands', () => {
    expect(hookStatementVoid(undefined, {})).toBe(false)
    expect(hookStatementVoid(iso(hookAt), {})).toBe(true)
    expect(hookStatementVoid(iso(hookAt), { lastCompactAt: longBefore })).toBe(true)
    expect(hookStatementVoid(iso(hookAt), { lastCompactAt: carried })).toBe(false)
    expect(hookStatementVoid(iso(hookAt), { lastCompactAt: iso(hookAt - 30_000) })).toBe(false)
    expect(hookStatementVoid(iso(hookAt), { lastCompactAt: iso(hookAt + HOOK_BOUNDARY_MS + 1) })).toBe(true)
    expect(hookStatementVoid('not a date', { lastCompactAt: longBefore })).toBe(false)
  })
})

describe('a fork\'s compaction tells the main conversation nothing', () => {
  const task = { org_role: 'lead', project: 'Walnut' } as const
  // Spawned before the news-once rule: its stored prompt lacks that line.
  const prompt = `${WALNUT_PROMPT_MARK}\n` + defaultInstructions(task).split('\n').filter((l) => l.trim() !== LEAD_NEWS_ONCE_LINE.trim()).join('\n')

  it('changed instructions: still due after a fork\'s hook statement, told after a real one', () => {
    // What noteInstructionNoticeStatedByHook records: every changed line, on the current boundary.
    const stated = instructionNoticeFor({ appliedAppendSystemPrompt: prompt, lastCompactUuid: 'c0' } as never, task)!
    expect(stated).toContain(LEAD_NEWS_ONCE_LINE.trim())
    const lines = defaultInstructions(task).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !prompt.includes(l))
    const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)
    const promptHash = h(prompt)
    const noted = { version: 'v', promptHash, compactUuid: 'c0', byHookAt: iso(hookAt), lines: lines.map(h) }
    const fork = { appliedAppendSystemPrompt: prompt, lastCompactUuid: 'c0', lastCompactAt: longBefore, taskRoutingNoted: noted }
    expect(instructionNoticeFor(fork as never, task)).toContain(LEAD_NEWS_ONCE_LINE.trim())
    const real = { ...fork, lastCompactAt: carried }
    expect(instructionNoticeFor(real as never, task)).toBeNull()
  })

  it('the told place: a fork\'s statement falls back to the prompt\'s place', () => {
    const p = `${WALNUT_PROMPT_MARK}\nYour task is "Lead" (t-1), in project "Walnut".`
    const base = { appliedAppendSystemPrompt: p, project: 'Walnut', lastCompactUuid: 'c0' }
    const placeNoted = { promptHash: placePromptHash(p), compactUuid: 'c0', byHookAt: iso(hookAt), project: 'Moved' }
    expect(toldPlaceOf({ ...base, lastCompactAt: carried, placeNoted } as never, 't-1').project).toBe('Moved')
    expect(toldPlaceOf({ ...base, lastCompactAt: longBefore, placeNoted } as never, 't-1').project).not.toBe('Moved')
  })

  it('message hints: a fork\'s statement of a changed hint leaves it owed to the main conversation', () => {
    const cfg = (lang: string) => ({ session: { reply_language: lang } }) as Pick<Config, 'session'>
    const rec: { claudeSessionId: string; hintState?: SessionHintState; lastCompactUuid?: string; lastCompactAt?: string } =
      { claudeSessionId: 's-lead', lastCompactUuid: 'c0', lastCompactAt: longBefore }
    const send = (config: Pick<Config, 'session'>, opts: { afterCompaction?: boolean; byHook?: boolean; now: number }) => {
      const plan = planHints({ hints: effectiveHints(config), target: { sessionId: rec.claudeSessionId }, record: rec as never, config, ...(opts.afterCompaction ? { afterCompaction: true } : {}) })
      rec.hintState = advanceHintState(rec.hintState, rec as never, plan.told, { now: opts.now, ...(opts.byHook ? { byHook: true, count: false } : { sentBy: 'person' }) })
      return plan.carried.map((c) => c.kind)
    }
    send(cfg('Chinese.'), { now: hookAt - 600_000 })
    // The user changes the reply language; the fork compacts and its hook states the new one.
    expect(send(cfg('French.'), { afterCompaction: true, byHook: true, now: hookAt })).toContain('reply-language')
    // The main conversation never read it: its next message still carries the change.
    const snapshot = structuredClone(rec)
    expect(send(cfg('French.'), { now: hookAt + 60_000 })).toContain('reply-language')
    // Had it been the conversation's own compaction (boundary read 2 s later), it is told.
    Object.assign(rec, structuredClone(snapshot), { lastCompactAt: carried })
    expect(send(cfg('French.'), { now: hookAt + 60_000 })).not.toContain('reply-language')
  })
})

describe('a hint with neither session_start nor every_turn', () => {
  it('stays owed after a fork\'s statement in a session that never compacted', () => {
    const config = (text: string) => ({ session: { output_mode: 'markdown', hints: { tone: { text, triggers: ['on_change', 'after_compaction'] } } } }) as unknown as Pick<Config, 'session'>
    const rec: { claudeSessionId: string; output_mode: 'markdown'; hintState?: SessionHintState; lastCompactAt?: string } = { claudeSessionId: 's-tone', output_mode: 'markdown' }
    const plan = (c: Pick<Config, 'session'>, afterCompaction = false) => planHints({ hints: effectiveHints(c), target: { sessionId: rec.claudeSessionId }, record: rec as never, config: c, ...(afterCompaction ? { afterCompaction: true } : {}) })
    // Told once as "Be brief." (seeded by hand: on_change alone never starts a hint).
    rec.hintState = { sends: 1, told: { tone: { send: 1, hash: plan(config('Be brief.'), true).told.tone, at: iso(hookAt - 600_000) } } }
    // The user rewrites it; a fork compacts and its hook states the new words.
    const hook = plan(config('Be very brief.'), true)
    rec.hintState = advanceHintState(rec.hintState, rec as never, hook.told, { now: hookAt, byHook: true, count: false })
    expect(plan(config('Be very brief.')).carried.map((c) => c.kind)).toContain('tone')
  })
})

describe('class guard', () => {
  it('every source file that writes a hook statement reads it back through hookStatementVoid', () => {
    const root = path.resolve(__dirname, '../../../src')
    const writers: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name)
        if (e.isDirectory()) walk(f)
        else if (f.endsWith('.ts') && /\bbyHook(At)?\s*:\s*(true|new Date|at\b)/.test(fs.readFileSync(f, 'utf8'))) writers.push(path.relative(root, f))
      }
    }
    walk(root)
    expect(writers.sort()).toEqual(['core/hints/hint-send.ts', 'core/sessions/instruction-notice.ts', 'core/sessions/place-notice.ts'])
    for (const w of writers) expect(fs.readFileSync(path.join(root, w), 'utf8'), w).toMatch(/hookStatementVoid\(/)
  })
})
