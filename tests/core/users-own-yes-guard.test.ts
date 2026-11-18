/**
 * Anything that involves other people, speaks in the user's name or cannot be undone waits for the
 * user's own explicit yes, whatever the Approvals switch says (src/core/approval-kinds.ts
 * USERS_OWN_YES_RULE).
 *
 * 2026-11-17: with approvals off, every lead's default instructions said "An outward message or post
 * is not the user's decision now: do it, or settle a teammate's outward ask without user_words". A VP
 * did just that: it signed the user up for a colleague's office hour and replied "I am signing up" in
 * his name, and he found his name on the list in the meeting. The user: "you need my approval for
 * everything that is irreversible or involves other people, and tell me when you decide for me".
 *
 * This guard reads every text Walnut hands a session as standing instructions (the charter, the
 * approvals-off line, the org defaults, every op's live help, the bundled skills, a composed session
 * prompt) and fails when one of them says an outward step needs no yes from the user again.
 */
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-users-own-yes'))

import { APPROVAL_KINDS, needsUsersWords, STILL_THE_USERS, SWITCH_OFF_SETTLES, USERS_OWN_YES_RULE } from '../../src/core/approval-kinds.js'
import { MESSAGE_TEXT_HINT, TEAM_CHARTER } from '../../src/core/team-charter.js'
import { approvalsLine } from '../../src/core/sessions/reply-language-context.js'
import { DEFAULT_ORG_INSTRUCTIONS } from '../../src/core/org/core-instructions.js'
import { buildSessionContext } from '../../src/core/sessions/session-context.js'
import { listOps } from '../../src/ops/index.js'
import type { Task } from '../../src/core/types.js'

const REPO = path.resolve(__dirname, '../..')

/** Wordings that hand an outward step (or the user's yes) to agents. One per way it was said or could be. */
const Q = "['’]" // a straight or a curly apostrophe
const NOT = `(?:is not|isn${Q}t|are not|aren${Q}t|is no longer|are no longer|no longer)`
// Not "yours": "deleting something that is not yours" is about ownership, not a decision.
const USERS = `(?:the user${Q}s(?: decision| call| to decide)?|his(?: decision| call| to decide)|theirs to decide)`
const STEP = '(?:outward|post|mail|message|reply|send|ping|sign[- ]?up|invite|publish)'
const HANDS_IT_OFF: RegExp[] = [
  new RegExp(`not the user${Q}s decision now`, 'i'),
  new RegExp(`\\b${STEP}[^.]{0,120}\\b${NOT} ${USERS}\\b`, 'i'),
  new RegExp(`\\b${NOT} (?:the user${Q}s|his|theirs) (?:decision|to decide|call)[^.]{0,80}\\b${STEP}`, 'i'),
  new RegExp(`\\b${STEP}[^.]{0,80}\\b(?:are|is) (?:yours|the agent${Q}s|the team${Q}s) to decide`, 'i'),
  /\bwithout (?:the user'?s |his )?user_words\b/i,
  /\bneeds? no user_words\b/i,
  new RegExp(`settles? (?:a teammate${Q}s |an? )?outward ask[^.]{0,40}\\b(?:without|no longer|needs? no)`, 'i'),
  new RegExp(`\\b(?:do|send|post|reply|sign up|go ahead)[^.]{0,60}without asking (?:the user|him|them|for (?:his|their|the user${Q}s) (?:yes|approval|words))`, 'i'),
  new RegExp(`\\bno need to ask (?:the user|him|them)\\b[^.]{0,60}${STEP}|${STEP}[^.]{0,60}\\bno need to ask (?:the user|him|them)\\b`, 'i'),
  new RegExp(`(?:needs?|requires?) no (?:yes|approval|words) (?:from|of) (?:the user|him)[^.]{0,60}${STEP}`, 'i'),
]

function offending(text: string): string[] {
  return HANDS_IT_OFF.filter((re) => re.test(text)).map((re) => `${re} -> "${text.match(re)![0]}"`)
}

/** Markdown an agent loads: the bundled skills, an integration's agent skills, the reference docs. */
function markdownUnder(rel: string, only?: RegExp): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p) } else if (e.name.endsWith('.md') && (!only || only.test(p))) out.push([path.relative(REPO, p), fs.readFileSync(p, 'utf8')])
    }
  }
  walk(path.join(REPO, rel))
  return out
}

function opTexts(): Array<[string, string]> {
  return listOps({ includeDeprecated: true }).map((op) => {
    const params = Object.entries(op.input ?? {}).map(([k, s]) => `${k}: ${(s as { description?: string }).description ?? ''}`)
    return [`op ${op.name}`, [op.description, ...params].join('\n')] as [string, string]
  })
}

describe('the user\'s own yes stays the user\'s, whatever the Approvals switch says', () => {
  it('the switch settles no approval kind, and outward is named among the kinds still his', () => {
    expect([...SWITCH_OFF_SETTLES]).toEqual([])
    expect(STILL_THE_USERS.outward).toMatch(/other people/)
    for (const kind of APPROVAL_KINDS) expect(needsUsersWords(kind, false), kind).toBe(true)
  })

  it('the charter carries the rule, with the classes the user named', () => {
    expect(TEAM_CHARTER).toContain(USERS_OWN_YES_RULE)
    for (const words of ['sign-up', 'office hour', 'invite', 'a reply or a ping', 'manager', 'in their name', 'public release',
      'whatever the Approvals switch says', 'a decision a lead or Main passes on is not that yes',
      'a standing permission they gave holds only in its own scope', 'tell them in that same turn']) {
      expect(USERS_OWN_YES_RULE, words).toContain(words)
    }
  })

  it('the approvals-off line says the switch never moves whose decision a step is', () => {
    const line = approvalsLine(false)
    expect(line).toMatch(/never whose decision a step is/)
    expect(line).toMatch(/explicit yes before anything that involves other people or speaks in the user's name/)
    expect(line).toMatch(/answers_ask\) only with user_words/)
  })

  it('every session prompt carries it once, through the charter, for Main, a lead and a worker', async () => {
    for (const role of [undefined, 'main', 'lead'] as const) {
      const t = { id: 'mt-yes-2', title: 'Fix the flaky auth test', project: 'marina', phase: 'IN_PROGRESS', ...(role ? { org_role: role } : {}) } as Task
      const prompt = (await buildSessionContext(t.id, '/x', 'h', { task: t })).systemPrompt
      expect(prompt.split(USERS_OWN_YES_RULE).length - 1, role ?? 'worker').toBe(1)
    }
  })

  it('no standing instruction hands an outward step to agents', async () => {
    const texts: Array<[string, string]> = [
      ['TEAM_CHARTER', TEAM_CHARTER],
      ['MESSAGE_TEXT_HINT', MESSAGE_TEXT_HINT],
      ['approvalsLine(off)', approvalsLine(false)],
      ...Object.entries(DEFAULT_ORG_INSTRUCTIONS).map(([r, t]) => [`org default ${r}`, t] as [string, string]),
      ...opTexts(),
      ...markdownUnder('src/data/skills'),
      ...markdownUnder('src/integrations', /agent-skills/),
      ...markdownUnder('docs/reference'),
    ]
    for (const role of [undefined, 'main', 'lead'] as const) {
      const t = { id: 'mt-yes-1', title: 'Fix the flaky auth test', project: 'marina', phase: 'IN_PROGRESS', ...(role ? { org_role: role } : {}) } as Task
      texts.push([`session prompt ${role ?? 'worker'}`, (await buildSessionContext(t.id, '/x', 'h', { task: t })).systemPrompt])
    }
    expect(texts.length).toBeGreaterThan(50)
    const found = texts.flatMap(([where, text]) => offending(text).map((o) => `${where}: ${o}`))
    expect(found).toEqual([])
  })

  it('each wording it refuses is one the old prompt really used', () => {
    const old = 'An outward message or post is not the user\'s decision now: do it, or settle '
      + 'a teammate\'s outward ask (task_send answers_ask) without user_words, and say what you did.'
    expect(offending(old).length).toBeGreaterThanOrEqual(3)
    for (const reworded of [
      'A post isn’t the user’s decision while approvals are off.',
      'Outward steps are yours to decide now.',
      'Reply to the colleague without asking the user.',
      'Settle a teammate\'s outward ask, it needs no user_words.',
    ]) expect(offending(reworded), reworded).not.toEqual([])
    for (const fine of [
      'Settle a teammate\'s outward ask only with user_words quoting them.',
      USERS_OWN_YES_RULE,
      approvalsLine(false),
    ]) expect(offending(fine), fine).toEqual([])
  })

  it('the messaging skill carries every clause of the rule', () => {
    const skill = fs.readFileSync(path.join(REPO, 'src/data/skills/walnut-session-messaging/SKILL.md'), 'utf8')
    expect(skill).toContain(USERS_OWN_YES_RULE)
  })
})
