/**
 * Guard: every step of a session turn is the same row (2026-11-11, the user picked
 * design 1 of the session chat designs: "I want them to be unified", "the message
 * send and receive also as one of new type", "no line needed").
 *
 * The class is "a row a turn's step renders as": a tool call, a command, a run of
 * calls, reasoning, a runtime line, injected context, a message sent, a message
 * received, the session's own words on the way. Each wears a StepIcon (a 16px line
 * icon) and a StepIcon chevron, never a text glyph such as "✓", "▶", "›" or "→".
 * The source scan lists every element of the session timeline that draws a row's
 * icon or chevron, so a new row with a glyph of its own fails here; the renders
 * check each kind as it really draws.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import { parseHTML } from 'linkedom'

// The markdown sanitizer binds to a document at import: one exists before the rows load.
const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
Object.assign(globalThis, { window: dom.window, document: dom.document })

vi.mock('@/utils/log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))
vi.mock('@/api/client', () => ({ apiPost: vi.fn(async () => ({ calls: {} })), apiGet: vi.fn(async () => ({})) }))
vi.mock('@/hooks/useEntityClickHandler', () => ({ useEntityClickHandler: () => () => {} }))
vi.mock('@/hooks/useEntityLabels', () => ({
  useRenderedMarkdown: (text: string) => `${text}`,
  useTaskLabel: () => undefined,
  useEntityLabelsVersion: () => 0,
  useSessionLabel: () => undefined,
}))

const { workedForLead, WORKING_LEAD, workDuration, secondsBetween } = await import('@/components/sessions/fold-steps')
const { needsPerson, callLine, FoldedWordsRow, LiftedStep } = await import('@/components/sessions/StepRows')
const { toolStepIcon, toolDisplayName } = await import('@/components/sessions/StepIcon')
const { toolTarget } = await import('@/components/sessions/step-target')
const { ProcessFoldRow } = await import('@/components/sessions/TurnFolds')
const { GenericToolCall, SessionThinking } = await import('@/components/sessions/SessionMessage')
const { SessionOutboundCards } = await import('@/components/sessions/SessionOutboundCard')
const { detectOutboundCalls } = await import('@/components/sessions/session-outbound')

const html = (el: unknown) => renderToStaticMarkup(el as never)
const firstIcon = (markup: string) => /data-step-icon="([a-z-]+)"/.exec(markup)?.[1]

describe('the fold line says how long the turn worked, then its steps', () => {
  it('leads with "Worked for <time>", the steps after it', () => {
    expect(workedForLead(136)).toBe('Worked for 2m 16s')
    expect(workedForLead(45.4)).toBe('Worked for 45s')
    expect(workedForLead(2 * 3600 + 5 * 60)).toBe('Worked for 2h 05m')
    expect(WORKING_LEAD).toBe('Working')
    expect(workDuration(59)).toBe('59s')
    expect(workDuration(60)).toBe('1m 00s')
  })
  it('says no time it does not know (no timestamps, under a second, a clock going back)', () => {
    expect(workedForLead(undefined)).toBeUndefined()
    expect(workedForLead(0.4)).toBeUndefined()
    expect(secondsBetween('2026-11-11T06:00:10Z', '2026-11-11T06:00:00Z')).toBeUndefined()
    expect(secondsBetween(undefined, '2026-11-11T06:00:00Z')).toBeUndefined()
    expect(secondsBetween('2026-11-11T06:00:00Z', '2026-11-11T06:02:16Z')).toBe(136)
  })
  it('the fold line has its chevron first and no rule under it', () => {
    const closed = html(createElement(ProcessFoldRow, { foldId: 'f1', lead: 'Worked for 9s', phrase: 'Ran 1 tool', testId: 'turn-fold' }, 'body'))
    expect(closed).toMatch(/<button[^>]*class="tool-run-toggle"[^>]*><span class="tool-run-chevron process-fold-chevron"><svg[^>]*data-step-icon="chevron"/)
    expect(closed.replace(/<[^>]+>/g, '')).toContain('Worked for 9s · Ran 1 tool')
    // The steps keep their own span: what the line counts reads the same as before.
    expect(closed).toContain('<span class="tool-run-label" title="Worked for 9s · Ran 1 tool">Ran 1 tool</span>')
    const css = readFileSync(join(__dirname, '../../web/src/styles/step-rows.css'), 'utf8')
    const foldRules = css.match(/\.process-fold[^{]*\{[^}]*\}/g) ?? []
    for (const rule of foldRules) expect(rule, rule).not.toMatch(/border-(bottom|top)\s*:\s*\d/)
  })
  it('a running fold shows what it does now under its closed line', () => {
    const live = html(createElement(ProcessFoldRow, { foldId: 'f2', lead: 'Working', phrase: 'Ran 1 tool', running: true, peek: 'NOW' }, 'body'))
    expect(live).toContain('data-testid="turn-fold-peek"')
    expect(live).toContain('NOW')
    const idle = html(createElement(ProcessFoldRow, { foldId: 'f3', phrase: 'Ran 1 tool', peek: 'NOW' }, 'body'))
    expect(idle).not.toContain('turn-fold-peek')
  })
})

describe('a step that stopped on the person is lifted out, red', () => {
  it('knows a permission rule’s refusal, never the person’s own no, an interrupt or an ordinary failure', () => {
    // A rule's refusal is lifted; the person's own no, or an interrupt, they already know of.
    expect(needsPerson('Permission for this action was denied by the Claude Code auto mode classifier.')).toBe(true)
    expect(needsPerson('Permission to use Bash has been denied.')).toBe(true)
    expect(needsPerson('User denied permission to use Bash')).toBe(false)
    expect(needsPerson("The user doesn't want to proceed with this tool use.")).toBe(false)
    expect(needsPerson('grep: no matches')).toBe(false)
    expect(needsPerson(undefined)).toBe(false)
  })
  it('says what the call was and why it stopped', () => {
    const out = html(createElement(LiftedStep, { name: 'Bash', input: { command: 'walnut tools call task_create', description: 'Create task for default auto mode' }, result: 'Permission for this action was denied.\nmore' }))
    expect(out).toContain('Create task for default auto mode')
    expect(out).toContain('Permission for this action was denied.')
    expect(firstIcon(out)).toBe('alert')
  })
})

describe('every kind of step is one row with its own line icon', () => {
  it('maps each tool family to its icon, and a Walnut op reads by its own name', () => {
    expect(toolStepIcon('Bash')).toBe('terminal')
    expect(toolStepIcon('Read')).toBe('eye')
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) expect(toolStepIcon(t)).toBe('pen')
    for (const t of ['Grep', 'Glob']) expect(toolStepIcon(t)).toBe('search')
    expect(toolStepIcon('Agent')).toBe('bot')
    expect(toolStepIcon('WebFetch')).toBe('globe')
    expect(toolStepIcon('mcp__walnut__host_exec')).toBe('monitor')
    expect(toolStepIcon('mcp__walnut__task_get')).toBe('walnut')
    expect(toolDisplayName('mcp__walnut__task_get')).toBe('task_get')
    expect(toolDisplayName('mcp__plugin_x_builder-mcp__ReadInternalWebsites')).toBe('ReadInternalWebsites')
    expect(callLine('Bash', { command: 'git status\nmore' })).toEqual({ label: 'git status', mono: true })
    // A row names what the call touched, never as `key: value`.
    expect(toolTarget('Read', { file_path: '/repo/a.ts', limit: 20 })).toBe('/repo/a.ts')
    expect(toolTarget('Grep', { pattern: 'WorkerPill', path: '/repo' })).toBe('WorkerPill')
    expect(toolTarget('WebFetch', { url: 'https://example.com', prompt: 'x' })).toBe('https://example.com')
    expect(callLine('Read', { file_path: '/repo/a.ts' })).toEqual({ label: 'Read /repo/a.ts', mono: false })
  })
  it('a tool call, a command, reasoning, a message sent and the session’s words each lead with a StepIcon', () => {
    const read = html(createElement(GenericToolCall, { tool: { name: 'Read', toolUseId: 'r1', input: { file_path: '/repo/a.ts' }, result: 'x' } as never, status: 'done' }))
    expect(firstIcon(read)).toBe('eye')
    const failed = html(createElement(GenericToolCall, { tool: { name: 'Grep', toolUseId: 'g1', input: { pattern: 'zz' }, result: 'none', isError: true } as never, status: 'error' }))
    expect(firstIcon(failed)).toBe('alert')
    const bash = html(createElement(GenericToolCall, { tool: { name: 'Bash', toolUseId: 'b1', input: { command: 'ls -la' }, result: 'ok' } as never, status: 'done' }))
    expect(firstIcon(bash)).toBe('terminal')
    expect(bash).toContain('chat-tool-block-command')
    const thought = html(createElement(SessionThinking, { text: '**Checking** the fold\nsecond line' }))
    expect(firstIcon(thought)).toBe('thought')
    expect(thought).toContain('Checking the fold')
    const tool = { name: 'Bash', toolUseId: 's1', input: { command: `walnut tools call task_send '{"to":"mw1","title":"Ready","text":"All done."}'` }, result: '{"ok":true}' }
    const calls = detectOutboundCalls(tool as never, tool.result)
    expect(calls.length).toBe(1)
    const sent = html(createElement(SessionOutboundCards, { calls, toolUseId: 's1', running: false, result: tool.result }))
    expect(firstIcon(sent)).toBe('send')
    const words = html(createElement(FoldedWordsRow, { text: 'It is the same deliverable, so reopen it.', foldKey: 'words:w1' }, 'full'))
    expect(firstIcon(words)).toBe('message')
    expect(words).toContain('It is the same deliverable, so reopen it.')
  })
})

describe('no row of the session timeline draws its icon or chevron as a text glyph', () => {
  const dir = join(__dirname, '../../web/src/components/sessions')
  const files = readdirSync(dir).filter((f) => f.endsWith('.tsx'))
  // The elements that hold a step row's icon or chevron.
  const SLOT = /className=\{?[`"'](?:[^`"']*\s)?(tool-run-chevron|chat-tool-block-icon|chat-tool-block-arrow|op-card-more-chevron|provenance-glyph)\b[^>]*>([^<]*)</g
  const found: string[] = []
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8')
    for (const m of src.matchAll(SLOT)) {
      const inner = m[2]!.trim()
      // `{icon ? <StepIcon … /> : glyph}` and `{statusIcon}` (a StepIcon) are the icon; text is not.
      if (inner === '' || inner === '{statusIcon}' || inner.startsWith('{icon ?')) continue
      found.push(`${f}: ${m[1]} holds ${JSON.stringify(inner)}`)
    }
  }
  it('every one holds a StepIcon', () => {
    expect(found).toEqual([])
  })
  it('the scan sees the rows it guards', () => {
    const all = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n')
    for (const slot of ['tool-run-chevron', 'chat-tool-block-icon', 'chat-tool-block-arrow', 'op-card-more-chevron', 'provenance-glyph']) expect(all).toContain(slot)
  })
})
