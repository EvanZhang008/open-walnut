/**
 * The team charter (src/core/team-charter.ts) reaches every place a session
 * learns how the org works: the task session prompt for each kind of caller,
 * the operating contract the Personal AI and lanes get, the op help a session
 * reads live, and the two skills.
 *
 * The scan at the bottom is the ratchet: every source file that hands a model a
 * system prompt is named here with where its text comes from. A new one fails
 * until someone decides whether it should carry the charter.
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-team-charter'))

import { MESSAGE_TEXT_HINT, TEAM_CHARTER } from '../../src/core/team-charter.js'
import { buildSessionContext } from '../../src/core/sessions/session-context.js'
import { renderSelfKnowledgeContract, SELF_KNOWLEDGE_PROMPT_MAX_CHARS } from '../../src/core/self-knowledge-contract.js'
import { buildRoleSection } from '../../src/core/sessions/persona-sections.js'
import { getOp } from '../../src/ops/index.js'
import type { Task } from '../../src/core/types.js'

const REPO = path.resolve(__dirname, '../..')
const count = (hay: string, needle: string) => hay.split(needle).length - 1

function task(over: Partial<Task>): Task {
  return { id: 'mt-rule-1', title: 'Fix the flaky auth test', project: 'marina', phase: 'IN_PROGRESS', ...over } as Task
}

describe('the charter itself', () => {
  it('keeps every point the user set', () => {
    for (const re of [
      /We are a startup: everyone has real power and we move fast\. No bureaucracy: no approval chains, no ceremony, no messages for their own sake\. Efficiency first\./,
      /The user and Main run the organization together as co-CEOs/,
      /Every agent runs the same model\. A higher layer holds different context, not better judgment\./,
      /The task doing the work has the most context, so it decides and finishes the work itself: plan, build, test, verify, review, commit, and deploy where the repo's own rules say done means deployed and let you do it\. It does not ask its lead or Main for approval and does not wait for review rounds\./,
      /Only some things are the user's to decide: an outward message or post, spending, credentials, permissions, deleting cloud resources or data, a hard-to-reverse choice no existing rule covers, and a fact only they have\./,
      /Everything else you decide and do, then say what you chose\./,
      /Undoing something an agent broke or changed \(a reinstall, a rebuild, a revert, a rerun\), choosing between reasonable options, and anything reversible are never theirs/,
      /if I am wrong, can I undo it, and can I read or try the answer\? If yes, decide/,
      /Information you cannot see, or a collision with another team's work, goes to the task that owns it or to your lead, not to the user/,
      /A lead or Main who is brought a question that is not the user's decides it and tells the team; it never passes it up/,
      /Whenever a task hands the user a decision \(a letter, a thread waiting on them\), Walnut asks which of these kinds it is/,
      /The user's word counts wherever Walnut's record shows they said it: a message of theirs in any node's chat \(task_history, rows with sentBy "person", from 2026-11-02 on: older ones may be an agent's unframed text; a row that also carries notices or another session's mail counts only through its personText\) or a thread message they wrote \(thread_list\)/,
      /never ask them to say it again in your own session\. Permission prompts, and approval rules that name a step/,
      /Testing and review scale with the change: a small one \(a revert to what production ran, CSS or copy, a few lines of no new logic\) runs only the tests it touches, on the user's engine, and its owner reads its own diff; a medium one adds its test groups and one review agent; only a large or risky one \(user data, concurrency, security, permissions, outward sends, the session daemon, a migration\) gets the full suite and an independent review\./,
      /A new coding task starts in its normal mode, never plan mode except when the user asks for plan: its owner writes the plan itself and carries on/,
      /A project lead assigns work, coordinates across teams and unblocks; it reads a team's work only when an outcome looks wrong\. Main sets direction with the user; it does not review implementation details\./,
      /send one only when the receiver must act on it\./,
      /No progress reports, acknowledgements, or relays of what the reader can read itself \(task_get, task_history\)/,
      /the conclusion first in plain, full sentences, then the decision needed or the next owner/,
      /long evidence in a file and give its path/,
      /what needs their action or changes their picture of the work, the important point first/,
      /When you pass on the user's request to another task, quote their own words first, exactly, with every screenshot they gave \(its path or link\), then your summary\./,
    ]) expect(TEAM_CHARTER).toMatch(re)
  })

  it('never costs a failure report, and grants nothing new', () => {
    expect(TEAM_CHARTER).toMatch(/Never leave out a failure, a safety limit or a risk/)
    expect(TEAM_CHARTER).toMatch(/An answer someone is waiting for is always sent: a reply to a request, an answer in a board thread, a letter the user asked for/)
    expect(TEAM_CHARTER).toMatch(/Standing rules you were given still apply: asking the user before splitting an ask into several tasks, the inbox rule, permission prompts/)
    expect(MESSAGE_TEXT_HINT).toMatch(/always send an answer someone is waiting for/)
    expect(MESSAGE_TEXT_HINT).toMatch(/Only the user's own decisions go to them \(outward steps, spending, credentials, permissions, cloud deletes, a hard-to-reverse choice no rule covers, a fact only they have\)/)
    expect(MESSAGE_TEXT_HINT).toMatch(/undoing what an agent broke, choosing between reasonable options and anything reversible are never theirs: decide it and say what you chose/)
    expect(MESSAGE_TEXT_HINT).toMatch(/Passing on the user's request: their exact words and screenshots first, your summary after\./)
    expect(TEAM_CHARTER).toMatch(/None of this permits an outward step, a public push, a destructive action or a way around a safety limit/)
    expect(TEAM_CHARTER).toMatch(/Before you report done or complete a task, re-read its description and every request you hold and check each item; anything not done goes in not_done\./)
    expect(TEAM_CHARTER).toMatch(/Never use a broader role \(an infrastructure or admin credential\) to get past an application's own access control; stop and tell its owner\./)
  })

  it('is plain ASCII English with no dash punctuation and no personal name', () => {
    for (const text of [TEAM_CHARTER, MESSAGE_TEXT_HINT]) {
      expect(text).not.toMatch(/[\u2013\u2014]/)
      expect(text).not.toMatch(/ - /)
      expect(text).toMatch(/^[\x20-\x7e\n]+$/)
    }
  })
})

describe('task session prompt (buildSessionContext: Claude Code, Codex non-lane, routines, host launches, offline merge)', () => {
  const cases: Array<[string, string, Task | undefined]> = [
    ['no task', '', undefined],
    ['worker', 'mt-rule-1', task({})],
    ['subtask of a leader', 'mt-rule-1', task({ parent_task_id: 'mt-rule-0' })],
    ['ask', 'mt-rule-1', task({ project: 'Ask Walnut', walnut_agent: true } as Partial<Task>)],
    ['project lead', 'mt-rule-1', task({ org_role: 'lead' } as Partial<Task>)],
    // Main is ask-like (org-store.ts ensureMainTask).
    ['main agent', 'mt-rule-1', task({ org_role: 'main', project: 'Ask Walnut', walnut_agent: true } as Partial<Task>)],
  ]
  for (const [label, id, t] of cases) {
    it(`carries the charter once for a ${label}`, async () => {
      const { systemPrompt } = await buildSessionContext(id, '/x', 'h', t ? { task: t } : undefined)
      expect(count(systemPrompt, TEAM_CHARTER)).toBe(1)
    })
  }

  it('words Main and a lead by the charter, routing by deliverable', async () => {
    const main = (await buildSessionContext('mt-rule-1', '/x', 'h', { task: task({ org_role: 'main' } as Partial<Task>) })).systemPrompt
    const lead = (await buildSessionContext('mt-rule-1', '/x', 'h', { task: task({ org_role: 'lead' } as Partial<Task>) })).systemPrompt
    for (const p of [main, lead]) expect(p).not.toMatch(/in a few lines/)
    expect(main).toMatch(/with the user you run their org as co-CEOs, and you set its direction with them/)
    expect(main).toMatch(/independent work gets task_create with its project named, the same deliverable gets task_send or task_start by its exact task id/)
    expect(main).toMatch(/never review implementation details/)
    expect(lead).toMatch(/You assign work, coordinate across teams and unblock/)
    expect(lead).toMatch(/Read a team's work \(task_get, task_history\) only when an outcome looks wrong/)
    expect(lead).toMatch(/independent work gets a fresh task even when a team already works in that area/)
    expect(lead).toMatch(/Route work the user or Main asked for by deliverable/)
    expect(lead).not.toMatch(/Never create or start a task/)
  })
})

describe('operating contract (Personal AI, console agents, ACP lanes)', () => {
  it('carries the charter once and stays under its cap', () => {
    const contract = renderSelfKnowledgeContract()
    expect(count(contract, TEAM_CHARTER)).toBe(1)
    expect(contract.length).toBeLessThanOrEqual(SELF_KNOWLEDGE_PROMPT_MAX_CHARS)
    expect(count(buildRoleSection('Ada'), TEAM_CHARTER)).toBe(1)
  })
})

describe('live op help (what a session spawned before a change still reads)', () => {
  const params: Array<[string, string]> = [
    ['task_send', 'text'], ['org_send', 'text'], ['board_post', 'text'], ['human_inbox_send', 'markdown'],
  ]
  for (const [op, param] of params) {
    it(`${op}.${param} carries the hint`, () => {
      const schema = getOp(op)?.input[param]
      expect(schema, `${op}.${param}`).toBeDefined()
      expect(schema!.description).toContain(MESSAGE_TEXT_HINT)
    })
  }
})

describe('skills', () => {
  const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf-8')

  it('walnut-session-messaging carries the charter for messages with an example, and lost the old "short" line', () => {
    const skill = read('src/data/skills/walnut-session-messaging/SKILL.md')
    expect(skill).toContain('## When to send, and how to write it')
    expect(skill).toContain('**Send only what the receiver must act on.**')
    expect(skill).toContain('without asking its lead or Main to approve a step')
    expect(skill).toContain('a hard-to-reverse choice no existing rule covers')
    expect(skill).toContain('Never the user\'s: undoing something an agent broke or changed')
    expect(skill).toContain('**The user\'s word counts wherever Walnut\'s record shows they said it.**')
    expect(skill).toContain('409 `user_kind`')
    expect(skill).toMatch(/Hard to act on:[\s\S]*Clear:/)
    expect(skill).not.toContain('Keep messages short and factual')
    expect(skill).toContain("**Pass on the user's words, not your reading of them.**")
  })

  it('the walnut skill points at it', () => {
    const skill = read('src/data/skills/walnut/SKILL.md')
    expect(skill).toMatch(/Send one only when the receiver must act on it/)
    expect(skill).toMatch(/only the user's own decisions go to them/)
    expect(skill).toMatch(/undoing what an agent broke or choosing between reasonable options never is/)
  })
})

/**
 * Every source file that passes a model a system prompt, and where its text
 * comes from. "new default" = built by buildSessionContext or the contract, so
 * it carries the charter; "inherited" = replays a prompt chosen earlier, byte for
 * byte; "custom" = a caller's own text, kept as given; "not a session" = a
 * one-shot model helper (titles, summaries, search) that messages no one.
 */
const PROMPT_SITES: Record<string, string> = {
  'src/providers/claude-code-session.ts':
    'new default: a fresh spawn appends buildSessionContext (after a caller-provided prompt when one is given); '
    + 'inherited: a side-thread fork takes the parent\'s exact prefix, and a resume replays the stored prompt',
  'src/providers/acp-session.ts':
    'new default: Codex developer_instructions from buildSessionContext, or the contract for a lane; '
    + 'custom: an explicit cfg.developerInstructions replaces the default; other ACP engines get no Walnut prompt',
  'src/providers/host-start-core.ts':
    'new default once that host runs this build: the persona copy plus the session context its replica built',
  'src/core/sessions/spawn-prefix.ts': 'inherited: reads back the prompt a session was spawned with',
  'src/providers/daemon-cron-supervision.ts': 'not a prompt source: lists CLI flags that take a value',
  'src/providers/cli-argv-files-core.ts': 'not a prompt source: moves the value of a prompt flag a caller built into a file and passes its path',
  'src/providers/inline-subagent.ts': 'not a session: one-shot helper with its own task prompt',
  'src/providers/micro-claude-warm.ts': 'not a session: warm helper process',
  'src/model/providers/adapter-claude-cli.ts': 'not a session: model adapter for helper calls',
}

describe('every system-prompt site is accounted for', () => {
  it('names each file that passes a prompt flag or Codex developer_instructions', () => {
    const found: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts')) {
          const src = fs.readFileSync(full, 'utf-8')
          if (/['"]--(?:append-)?system-prompt(?:-file)?['"]|developer_instructions/.test(src)) {
            found.push(path.relative(REPO, full))
          }
        }
      }
    }
    walk(path.join(REPO, 'src'))
    expect(found.sort()).toEqual(Object.keys(PROMPT_SITES).sort())
  })
})

/**
 * 2026-11-09 org reflection: the user set at most 3 review rounds ("Rate max 3 round, why this like 17
 * round"), and two tasks reached rounds 9 and 12 under a lead's brief that still said 6. The cap lives in
 * the charter alone; this scan fails when any other default text Walnut ships (source strings, shipped
 * skills) names a round limit of its own, since a second number is how the old 6 got frozen in.
 */
describe('review round cap and wrong-chat forwarding', () => {
  it('the charter caps review at 3 rounds that no brief can raise', () => {
    expect(TEAM_CHARTER).toMatch(/Review stops after 3 rounds on one change, then fix what it found once and land; this cap is Walnut's, and no brief, task description or lead's rule raises it, only the user's own words\./)
  })

  it('the charter forwards a wrong-chat message instead of asking the user to resend it', () => {
    expect(TEAM_CHARTER).toMatch(/When the user says a message reached the wrong chat, forward their exact words and screenshots to the task that owns them \(task_send\) and tell them where it went; never ask them to resend it\./)
  })

  it('no other shipped default text names a review round limit', () => {
    const NUM = '(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve)'
    // Text a session reads (strings in source, every line of a shipped skill; never a code comment):
    // any count of rounds on a line about review ("stops after 6 rounds", "max 6 review rounds"),
    // or a limit word on review rounds; a comment naming one round ("review round 3") is no limit.
    const limit = new RegExp(`\\b${NUM}\\s+(?:review\\s+)?rounds?\\b|\\breview rounds?\\s*(?:max|limit|cap)\\b`, 'i')
    // The scan itself: the charter's own wording with another number is caught.
    expect(limit.test('Review stops after 6 rounds on one change')).toBe(true)
    expect(limit.test('Reviews: at most six rounds')).toBe(true)
    expect(limit.test('max 6 review rounds')).toBe(true)
    expect(limit.test('a reviewer fix (review round 3, Sol)')).toBe(false)
    const hits: string[] = []
    const walk = (dir: string, ext: RegExp) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full, ext)
        else if (ext.test(entry.name)) {
          const rel = path.relative(REPO, full)
          if (rel === 'src/core/team-charter.ts') continue
          fs.readFileSync(full, 'utf-8').split('\n').forEach((line, i) => { if (/review/i.test(line) && limit.test(line) && !(rel.endsWith('.ts') && /^\s*(?:\*|\/\/|\/\*)/.test(line))) hits.push(`${rel}:${i + 1}: ${line.trim()}`) })
        }
      }
    }
    walk(path.join(REPO, 'src'), /\.(?:ts|md)$/)
    expect(hits).toEqual([])
  })
})
