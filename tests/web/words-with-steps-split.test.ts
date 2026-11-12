/**
 * Words and the calls written with them in ONE message: the words stay on
 * screen and the calls fold as a step right after them, whatever the calls are
 * (2026-11-09, the user, of a send card standing open between two paragraphs of
 * an answer: "the message should also be auto collapsed ... like send message 1,
 * etc instead of just show this").
 *
 * The class: an assistant row with words and calls. The history builder splits
 * it into its words and its calls only through `isTextPlusMergeableTools`
 * (generic tools, which go forward into a run) and `isTextPlusStepTools` (a send
 * among them, a part of its own). This walks every kind of call a row can carry,
 * alone and in pairs, and fails when every call is a step the fold rule folds
 * (fold-rows.ts `toolRole`) but the row is not split, so a step would stand open
 * inside the words' row. Calls that are no step (a question, a plan, an agent's
 * card) stay on screen either way.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseHTML } from 'linkedom'
import type { SessionHistoryMessage, SessionHistoryTool } from '../../web/src/types/session'

let SM: typeof import('../../web/src/components/sessions/SessionMessage')
let outbound: typeof import('../../web/src/components/sessions/session-outbound')
let rows: typeof import('../../web/src/components/sessions/fold-rows')
beforeAll(async () => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  Object.assign(globalThis, { window: dom.window, document: dom.document })
  // After the document exists: the markdown sanitizer binds to it at import.
  SM = await import('../../web/src/components/sessions/SessionMessage')
  outbound = await import('../../web/src/components/sessions/session-outbound')
  rows = await import('../../web/src/components/sessions/fold-rows')
})

const done = '{"outcome":"Delivered."}'
/** One of every kind of call: generic, the sends (MCP and the CLI's), Walnut's messaging ops, the cards. */
const CALLS: Record<string, SessionHistoryTool> = {
  read: { name: 'Read', input: { file_path: '/tmp/a.ts' }, result: 'a' },
  bash: { name: 'Bash', input: { command: 'make' }, result: 'ok' },
  failed: { name: 'Bash', input: { command: 'make' }, result: 'error', isError: true },
  running: { name: 'Bash', input: { command: 'sleep 9' } },
  mcpOther: { name: 'mcp__other__lookup', input: { q: 'x' }, result: 'y' },
  taskSend: { name: 'mcp__walnut__task_send', input: { to: 'abc', title: 'Pick C', text: 'Pick C.' }, result: done },
  reply: { name: 'mcp__walnut__task_send', input: { in_reply_to: 'rq-1', text: 'Done.' }, result: done },
  cliSend: { name: 'Bash', input: { command: `walnut tools call task_send '{"to":"abc","text":"Pick C."}'` }, result: done },
  orgSend: { name: 'mcp__walnut__org_send', input: { project: 'P', text: 'x' }, result: done },
  inbox: { name: 'mcp__walnut__human_inbox_reply', input: { letter_id: 'l', text: 'x' }, result: done },
  question: { name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] } },
  plan: { name: 'ExitPlanMode', input: { plan: 'Do it.' } },
  agent: { name: 'Task', input: { description: 'look', prompt: 'look' } },
  todo: { name: 'TodoWrite', input: { todos: [{ content: 'x', status: 'pending' }] } },
}

const withWords = (tools: SessionHistoryTool[]): SessionHistoryMessage => ({ role: 'assistant', text: 'My pick is C.', timestamp: '2026-11-09T10:00:00Z', msgId: 'm1', tools } as SessionHistoryMessage)

describe('words with calls: the calls fold after the words exactly when they are steps', () => {
  it('every kind of call, alone and in pairs', () => {
    const foldable = (t: SessionHistoryTool) => SM.isMergeableHistoryTool(t) || !!outbound.detectOutboundSend(t)
    const names = Object.keys(CALLS)
    const sets: string[][] = [...names.map((n) => [n]), ...names.flatMap((a) => names.map((b) => [a, b]))]
    const wrong: string[] = []
    let splits = 0
    for (const set of sets) {
      const m = withWords(set.map((n) => CALLS[n]))
      const split = SM.isTextPlusMergeableTools(m) || SM.isTextPlusStepTools(m)
      const steps = m.tools!.every((t) => rows.TOOL_ROLE_FOLDS[rows.toolRole(t, foldable)])
      if (steps && !split) wrong.push(`${set.join('+')}: its calls are steps, but they stay in the words' row`)
      if (steps) splits++
    }
    expect(wrong).toEqual([])
    expect(splits).toBeGreaterThan(50)
  })

  it('the sends are steps: a send with words is split off them', () => {
    for (const n of ['taskSend', 'reply', 'cliSend']) expect(SM.isTextPlusStepTools(withWords([CALLS[n]])), n).toBe(true)
    // No words: nothing to split, the row is a step already.
    expect(SM.isTextPlusStepTools({ ...withWords([CALLS.taskSend]), text: '' })).toBe(false)
  })

  it('the history builder splits both ways, and the calls part never repeats the words', () => {
    const src = readFileSync(join(__dirname, '../../web/src/components/sessions/SessionChatHistory.tsx'), 'utf8')
    expect(src).toMatch(/if \(isTextPlusMergeableTools\(msg\)\) \{[\s\S]*?suppressTools: true[\s\S]*?continue;\s*\}\s*if \(isTextPlusStepTools\(msg\)\) \{\s*[\s\S]*?parts\.push\(\{ kind: 'msg', m: msg, globalIndex, suppressTools: true \}\);[\s\S]*?ids\.derive\(prose, 'tools-after', \[\], \(\) => \(\{ \.\.\.prose, text: '', thinking: undefined \}\)\), globalIndex, toolsAfter: true \}\);\s*continue;/)
    // The calls part shares its words' message id: never a second key, copy bar, reply overlay or jump target.
    expect(src).toContain("key={part.toolsAfter ? `tools-after:")
    expect(src).toContain('data-message-id={part.toolsAfter ? undefined :')
    expect(src).toContain('globalIndex === lastAssistantTextIndex && !part.toolsAfter')
    expect(src).toContain('!stream && !part.toolsAfter && part.m.msgId ? replyTextOverlay.get')
    expect(src).toContain("if (part.kind === 'msg' && part.toolsAfter) continue;")
    // Nor a second divider, Asked-from list or action strip; and a divider never makes the calls read.
    expect(src).toContain('{!part.toolsAfter && gapDivider(globalIndex)}')
    expect(src).toContain('{!part.toolsAfter && forkBoundaryIndex != null && globalIndex === forkBoundaryIndex && (')
    expect(src.match(/const divides = !\(part\.kind === 'msg' && part\.toolsAfter\);\s*if \(divides && /g)).toHaveLength(2)
    expect(src).toContain("if (part.kind === 'msg' && part.toolsAfter) return;\n      host = i;")
    expect(src).toContain('{...(part.toolsAfter ? { noActions: true } : {})}')
    // A lone send is always a fold, never its card on its own. Since 2026-11-12 every lone
    // step is (the user: "event one shoudol be collpesed"): no lone-row path is left at all.
    expect(src).not.toMatch(/items\.length === 1 && !answerThinking/)
  })
})
