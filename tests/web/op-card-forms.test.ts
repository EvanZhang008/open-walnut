/**
 * Guard: every Walnut op that carries words to someone shows those words on its
 * chat card, whatever way the session made the call.
 *
 * 2026-11-09, the user, of a lead's chat where every send read "Payload from file
 * — the text is not in this transcript": "can it show the summary as we said? ...
 * even if it use cli, why can't it show up here?". The lead wrote each payload
 * with a heredoc into /tmp and sent `@/tmp/x.json`, and updated two threads in the
 * same command; the card read only the first call, and only inline JSON.
 *
 * The class is (op × call form). Ops come from the registry: an op taking a
 * message-like argument is carded (core/op-cards.ts OP_CARDS) or says why not
 * (NOT_CARDED), so a new op fails here until it is one or the other. Forms: an MCP
 * tool, inline JSON, flags, a heredoc or echo into a file then `@file`, stdin from
 * echo or a heredoc, and a file or program the transcript does not hold (then the
 * words come from Walnut's own record of the call, op-call-log.ts). Each one is
 * rendered folded and must show the words, never the "no copy" line.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import { listOps } from '../../src/ops/index.js'
import { MESSAGE_ARG_KEYS, NOT_CARDED, OP_CARDS, opCardFields } from '../../src/core/op-cards.js'
import { detectOutboundCalls } from '@/components/sessions/session-outbound'
import { SessionOutboundCards } from '@/components/sessions/SessionOutboundCard'
import { _resetOpCallStore, _setOpCalls, type OpCallRecord } from '@/stores/op-call-store'
import type { SessionHistoryTool } from '@/types/session'

vi.mock('@/utils/log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))
// The markdown renderer needs a real DOM (DOMPurify); the folded card shows plain
// fields, and the open card's words are the text itself here.
// Clicks need a router; this test reads what the card says.
vi.mock('@/hooks/useEntityClickHandler', () => ({ useEntityClickHandler: () => () => {} }))
vi.mock('@/hooks/useEntityLabels', () => ({
  useRenderedMarkdown: (text: string) => `${text}`,
  useTaskLabel: () => undefined,
  useEntityLabelsVersion: () => 0,
}))

const SID = 'aaaaaaaa-1111-4222-8333-444444444444'

/** Arguments for `op` whose words carry a marker the card must show. */
function sampleArgs(op: string): Record<string, unknown> {
  const input = (listOps({ includeDeprecated: true }).find((o) => o.name === op)?.input ?? {}) as Record<string, unknown>
  const args: Record<string, unknown> = {}
  const marker = `Marker words for ${op} go here. Then a second sentence with more of what was said.`
  for (const k of MESSAGE_ARG_KEYS) if (k in input) args[k] = marker
  for (const k of ['to', 'task', 'id', 'letter', 'thread']) if (k in input) args[k] = 'mw0abcde-1234'
  if ('title' in input) args.title = `Title of ${op}`
  if ('subject' in input) args.subject = `Title of ${op}`
  return args
}

/** What the folded card must say: the title the sender gave, else the first sentence. */
function expectedWords(op: string): string {
  const f = opCardFields(op, sampleArgs(op))!
  return f.title!
}

function bash(command: string, toolUseId = 'toolu_1', result?: string): SessionHistoryTool {
  return { name: 'Bash', input: { command }, toolUseId, ...(result !== undefined ? { result } : {}) }
}

const FORMS: Array<{ name: string; tool: (op: string, json: string) => SessionHistoryTool; recorded?: boolean }> = [
  { name: 'MCP tool', tool: (op) => ({ name: `mcp__walnut__${op}`, input: sampleArgs(op), toolUseId: 'toolu_1' }) },
  { name: 'inline JSON', tool: (op, json) => bash(`walnut tools call ${op} '${json}'`) },
  { name: 'heredoc into a file, then @file', tool: (op, json) => bash(`cat > /tmp/vp-a.json <<'EOF'\n${json}\nEOF\nwalnut tools call ${op} @/tmp/vp-a.json 2>&1 | head -3`) },
  { name: 'echo into a file, then @file', tool: (op, json) => bash(`echo '${json}' > /tmp/vp-b.json && walnut tools call ${op} @/tmp/vp-b.json`) },
  { name: 'stdin from echo', tool: (op, json) => bash(`echo '${json}' | walnut tools call ${op} -`) },
  { name: 'stdin from a heredoc on the call', tool: (op, json) => bash(`walnut tools call ${op} - <<'EOF'\n${json}\nEOF`) },
  { name: '@file the transcript does not hold', tool: (op) => bash(`walnut tools call ${op} @/tmp/gone.json | grep -o requestId`), recorded: true },
  { name: 'stdin from a program', tool: (op) => bash(`python3 make_args.py | walnut tools call ${op} -`), recorded: true },
]

function recordFor(op: string): OpCallRecord {
  return { id: `oc-${op}`, at: new Date().toISOString(), toolUseId: 'toolu_1', op, form: 'file', ok: true, fields: opCardFields(op, sampleArgs(op))! }
}

function render(tool: SessionHistoryTool): string {
  const calls = detectOutboundCalls(tool, tool.result)
  expect(calls.length).toBeGreaterThan(0)
  return renderToStaticMarkup(createElement(SessionOutboundCards, { calls, toolUseId: tool.toolUseId, running: false, sessionId: SID }))
}

/** The text as the markup holds it (React escapes quotes and ampersands). */
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

beforeEach(() => _resetOpCallStore())

describe('which ops card', () => {
  it('every op with a message-like argument is carded or says why not', () => {
    const missing: string[] = []
    for (const op of listOps({ includeDeprecated: true })) {
      const keys = Object.keys(op.input ?? {}).filter((k) => MESSAGE_ARG_KEYS.includes(k))
      if (keys.length && !(op.name in OP_CARDS) && !(op.name in NOT_CARDED)) missing.push(`${op.name} (${keys.join(', ')})`)
    }
    expect(missing, 'add each to OP_CARDS (it carries words to someone) or NOT_CARDED (with why) in src/core/op-cards.ts').toEqual([])
  })

  it('names only ops that exist', () => {
    const names = new Set(listOps({ includeDeprecated: true }).map((o) => o.name))
    expect(Object.keys(OP_CARDS).filter((n) => !names.has(n))).toEqual([])
    expect(Object.keys(NOT_CARDED).filter((n) => !names.has(n))).toEqual([])
  })
})

describe('every carded op shows its words in every call form', () => {
  for (const op of Object.keys(OP_CARDS)) {
    for (const form of FORMS) {
      it(`${op}: ${form.name}`, () => {
        if (form.recorded) _setOpCalls(SID, 'toolu_1', [recordFor(op)])
        const html = render(form.tool(op, JSON.stringify(sampleArgs(op))))
        expect(html).toContain(esc(expectedWords(op)))
        expect(html).not.toMatch(/kept no copy|not in this transcript/)
      })
    }
  }
})

describe('one command, several calls', () => {
  it('cards each call with its own words (a send, then two thread updates)', () => {
    const send = JSON.stringify({ to: 'mw0abcde-1234', text: 'Hand the tab cleanup to the browser task. It owns the window.' })
    const t1 = JSON.stringify({ task: 'mw0abcde-1234', id: 'th-aaaa', merge_into: 'th-bbbb' })
    const t2 = JSON.stringify({ task: 'mw0abcde-1234', id: 'th-bbbb', reply: 'Handed to the browser task with the screenshot.' })
    const command = [
      `cat > /tmp/vp-send.json <<'EOF'`, send, 'EOF',
      `walnut tools call task_send @/tmp/vp-send.json 2>&1 | grep -o -E '"(requestId|delivery)": "[^"]*"'`,
      `walnut tools call thread_update '${t1}' 2>&1 | head -1`,
      `cat > /tmp/vp-th.json <<'EOF'`, t2, 'EOF',
      'walnut tools call thread_update @/tmp/vp-th.json',
    ].join('\n')
    const calls = detectOutboundCalls(bash(command))
    expect(calls.map((c) => c.op)).toEqual(['task_send', 'thread_update', 'thread_update'])
    const html = render(bash(command))
    expect(html).toContain('Hand the tab cleanup to the browser task.')
    expect(html).toContain('Merged into another thread (th-bbbb).')
    expect(html).toContain('Handed to the browser task with the screenshot.')
  })

  it("Walnut's record wins, a loop's every send included", () => {
    const command = 'for id in a b; do walnut tools call task_send "$(python3 mk.py $id)"; done'
    const rec = (n: number): OpCallRecord => ({ ...recordFor('task_send'), id: `oc-${n}`, fields: opCardFields('task_send', { to: `mw0abcde-000${n}`, text: `Loop send number ${n}. More.` })! })
    _setOpCalls(SID, 'toolu_1', [rec(1), rec(2)])
    const html = render(bash(command))
    expect(html).toContain('Loop send number 1.')
    expect(html).toContain('Loop send number 2.')
  })

  it('a refused call says so on its card', () => {
    _setOpCalls(SID, 'toolu_1', [{ ...recordFor('human_inbox_send'), ok: false, error: '409 user_kind: name the kind' }])
    const html = render(bash('walnut tools call human_inbox_send @/tmp/l.json'))
    expect(html).toContain('409 user_kind: name the kind')
  })
})

describe('prose and help never card', () => {
  it('a heredoc body that mentions a call is data', () => {
    const command = "cat > /tmp/notes.md <<'EOF'\nRun walnut tools call task_send '{\"text\":\"x\"}' later\nEOF"
    expect(detectOutboundCalls(bash(command))).toEqual([])
  })
  it('help and quoted prose', () => {
    expect(detectOutboundCalls(bash('walnut tools call thread_update --help'))).toEqual([])
    expect(detectOutboundCalls(bash('echo "walnut tools call brief_write now"'))).toEqual([])
    expect(detectOutboundCalls(bash("walnut tools call task_get '{\"id\":\"x\"}'"))).toEqual([])
  })
})
