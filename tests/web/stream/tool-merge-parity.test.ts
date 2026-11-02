/**
 * A tool call folds into a "Ran 3 commands" run, or stands as its own card, the
 * same way while it streams and once its saved row takes over (2026-11-01, the
 * user: streaming and finished must look exactly the same, "no change of
 * format"). The live rule (group-blocks.ts) and the saved rule (SessionMessage)
 * kept a list each: a message to another session folded into the live run and
 * stood as a card in the saved one. Both now read stream/tool-merge.ts; this
 * checks every tool shape gives one answer on both sides, running and finished,
 * and that neither side decides anything of its own beside it.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseHTML } from 'linkedom'
import { isMergeableToolBlock } from '@/stream/group-blocks'
import type { StreamingBlock } from '@/stream/stream-reducer'

let isMergeableHistoryTool: typeof import('../../../web/src/components/sessions/SessionMessage').isMergeableHistoryTool

beforeAll(async () => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  Object.assign(globalThis, { window: dom.window, document: dom.document })
  ;({ isMergeableHistoryTool } = await import('../../../web/src/components/sessions/SessionMessage'))
})

const SHAPES: Array<{ label: string; name: string; input: Record<string, unknown>; result: string; merges: boolean }> = [
  { label: 'a shell command', name: 'Bash', input: { command: 'ls -la' }, result: 'total 0', merges: true },
  { label: 'a file read', name: 'Read', input: { file_path: '/repo/src/a.ts' }, result: '1\tconst a = 1', merges: true },
  { label: 'an edit', name: 'Edit', input: { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }, result: 'ok', merges: true },
  { label: 'a plain write', name: 'Write', input: { file_path: '/repo/a.md', content: 'x' }, result: 'ok', merges: true },
  { label: 'a search', name: 'Grep', input: { pattern: 'foo' }, result: 'a.ts', merges: true },
  { label: 'an MCP tool', name: 'mcp__notes__read', input: { path: 'x' }, result: 'x', merges: true },
  {
    label: 'a CLI message to another task',
    name: 'Bash',
    input: { command: `walnut tools call task_send '{"task":"t-1","text":"hi"}'` },
    result: '{"ok":true,"requestId":"rq-abcdef123456"}',
    merges: false,
  },
  {
    label: 'a CLI reply to a request',
    name: 'Bash',
    input: { command: `walnut tools call task_send '{"in_reply_to":"rq-abcdef123456","text":"done"}'` },
    result: '{"ok":true}',
    merges: false,
  },
  { label: 'an MCP message to another task', name: 'mcp__walnut__task_send', input: { task: 't-1', text: 'hi' }, result: '{"ok":true}', merges: false },
  { label: 'a plan write', name: 'Write', input: { file_path: '/home/u/.claude/plans/p.md', content: '# plan' }, result: 'ok', merges: false },
  { label: 'a plan exit', name: 'ExitPlanMode', input: { plan: '# plan' }, result: 'ok', merges: false },
  { label: 'an agent spawn', name: 'Agent', input: { description: 'look', prompt: 'look' }, result: 'done', merges: false },
  { label: 'a task spawn', name: 'Task', input: { description: 'look', prompt: 'look' }, result: 'done', merges: false },
  { label: 'a call with no input and no result', name: 'Bash', input: {}, result: '', merges: false },
]

describe('a tool call merges the same way live and saved', () => {
  for (const s of SHAPES) {
    it(`${s.label}: ${s.merges ? 'joins the run' : 'stands alone'} on both sides, running and finished`, () => {
      const running: StreamingBlock = { type: 'tool_call', toolUseId: 'tu-1', name: s.name, input: s.input, status: 'calling' } as StreamingBlock
      const finished: StreamingBlock = { type: 'tool_call', toolUseId: 'tu-1', name: s.name, input: s.input, status: 'done', result: s.result } as StreamingBlock
      const saved = { toolUseId: 'tu-1', name: s.name, input: s.input, result: s.result }
      expect(isMergeableToolBlock(running), 'live, running').toBe(s.merges)
      expect(isMergeableToolBlock(finished), 'live, finished').toBe(s.merges)
      expect(isMergeableHistoryTool(saved as never), 'saved').toBe(s.merges)
    })
  }

  it('neither side keeps an exception of its own beside the shared rule', () => {
    const root = join(__dirname, '../../../web/src')
    const live = readFileSync(join(root, 'stream/group-blocks.ts'), 'utf8')
    const saved = readFileSync(join(root, 'components/sessions/SessionMessage.tsx'), 'utf8')
    const body = (src: string, fn: string): string => {
      const at = src.indexOf(`function ${fn}(`)
      expect(at, `${fn} not found`).toBeGreaterThan(-1)
      const open = src.indexOf('{\n', at)
      let depth = 0
      for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++
        else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1)
      }
      return src.slice(open)
    }
    const liveBody = body(live, 'isMergeableToolBlock')
    const savedBody = body(saved, 'isMergeableHistoryTool')
    expect(liveBody).toContain('toolMergesIntoRun(')
    expect(savedBody).toContain('toolMergesIntoRun(')
    // A tool name or a send check written into either body is a second list.
    for (const [side, src] of [['live', liveBody], ['saved', savedBody]] as const) {
      expect(src, `${side} names a tool of its own`).not.toMatch(/'(ExitPlanMode|Agent|Task|Write|Bash)'/)
      expect(src, `${side} checks sends itself`).not.toMatch(/detectOutboundSend|GROUPABLE/)
    }
  })
})
