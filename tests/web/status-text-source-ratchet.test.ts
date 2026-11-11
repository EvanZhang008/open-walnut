/**
 * Ratchet: a task's stored words (its report, wait, ask, line, summary, last words, result) open a
 * path where Walnut recorded they were written, never through the task's current session.
 *
 * 2026-11-07: every status surface passed `task={task}` to AgentText, so a path in words an older
 * session wrote opened through whichever session the task runs now, on another machine. The class
 * is "agent text whose source is the task": the fix is taskTextSource (utils/agent-text-source.ts),
 * which reads only the stored writer and says unknown when there is none.
 *
 * Fails when:
 *  - any AgentText in web/src takes `task=` (the current-session fallback), outside the list below;
 *  - a listed status slot loses its writer-based source or names another field;
 *  - a status AgentText takes its source from the task's live session (resolveTaskSessionId, session_id);
 *  - taskTextSource itself starts reading the task's current session.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { ModuleGraph, readSources, stripExt } from './agent-guard-ast'

const WEB = path.resolve('web/src')
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), 'utf8')
const graph = new ModuleGraph(readSources(WEB), WEB)
const renderer = `${stripExt(path.join(WEB, 'components/common/AgentText.tsx'))}#AgentText`

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.tsx$/.test(e.name)) out.push(p)
  }
  return out
}

type Use = { attrs: Record<string, string | true>; spreads: string[]; line: number }

/** Every <AgentText> in a source, with its attributes and its spread expressions. */
function agentTextUses(text: string, file: string): Use[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const fileKey = graph.keyOf(file)
  const out: Use[] = []
  const visit = (n: ts.Node) => {
    if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && ts.isIdentifier(n.tagName) && graph.resolveBinding(fileKey, n.tagName.text) === renderer) {
      const attrs: Record<string, string | true> = {}
      const spreads: string[] = []
      for (const a of n.attributes.properties) {
        if (ts.isJsxSpreadAttribute(a)) { spreads.push(a.expression.getText(sf)); continue }
        const v = a.initializer
        attrs[a.name.getText(sf)] = !v ? true : ts.isJsxExpression(v) ? (v.expression?.getText(sf) ?? '') : ts.isStringLiteral(v) ? v.text : v.getText(sf)
      }
      out.push({ attrs, spreads, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** Files still handing AgentText a task, each with why that task is not a status writer guess. */
const TASK_PROP_ALLOWED: Record<string, string> = {}

/** The status slots and the source each must use, keyed by the slot's text expression. */
const SLOTS: Record<string, Array<{ text: string | RegExp; source: string | RegExp }>> = {
  'components/tasks/StatusSections.tsx': [
    { text: 'need.text', source: "taskTextSource(task, 'needs')" },
    { text: 'reasonText', source: "taskTextSource(task, 'waiting')" },
  ],
  'components/tasks/WaitingChip.tsx': [
    { text: 'l', source: 'rows[i]!.source' },
  ],
  'components/board/BoardStatusView.tsx': [
    { text: 'waitingLine(s, formatWaitUntil)', source: "taskTextSource(row.task, 'waiting')" },
    { text: 's.now', source: "taskTextSource(row.task, 'report')" },
    { text: /^`Not done: /, source: "taskTextSource(row.task, 'partial')" },
    { text: 'line.text', source: "taskTextSource(row.task, 'needs')" },
    { text: 's.next', source: "taskTextSource(row.task, 'report')" },
    { text: /^n\.line\b/, source: "taskTextSource(tasks.find((t) => t.id === n.id), 'needs')" },
  ],
  'components/sessions/SessionTaskbar.tsx': [
    { text: 'line', source: 'lineSource' },
  ],
  'components/org/OrgTaskRail.tsx': [
    { text: 'note', source: /^\(noteField \? taskTextSource\(t, noteField\) : \{ unknownSource: true \}\)$/ },
    { text: 'summary', source: 'askSource' },
    { text: 'more', source: 'askSource' },
  ],
  'popout/PopoutExtTasks.tsx': [
    { text: 's', source: /^\(saidSources\[i\] \?\? \{ unknownSource: true \}\)$/ },
  ],
}

const matches = (v: string, want: string | RegExp) => (typeof want === 'string' ? v === want : want.test(v))

describe('a task\'s stored words open where they were written', () => {
  it('no AgentText falls back to the task\'s current session through `task=`', () => {
    const found = new Map<string, number[]>()
    for (const file of walk(WEB)) {
      const text = fs.readFileSync(file, 'utf8')
      const rel = path.relative(WEB, file).split(path.sep).join('/')
      const lines = agentTextUses(text, file).filter((u) => 'task' in u.attrs).map((u) => u.line)
      if (lines.length) found.set(rel, lines)
    }
    const off = [...found].filter(([f]) => !TASK_PROP_ALLOWED[f]).map(([f, l]) => `${f}:${l.join(',')}`)
    expect(off, 'name the words\' writer with taskTextSource(task, field), never task={task}').toEqual([])
    const stale = Object.keys(TASK_PROP_ALLOWED).filter((f) => !found.has(f))
    expect(stale, 'allowed files that no longer pass a task: drop them').toEqual([])
  })

  it('every status slot reads the writer of its own field', () => {
    for (const [file, slots] of Object.entries(SLOTS)) {
      const uses = agentTextUses(read(file), path.join(WEB, file))
      const source = file === 'popout/PopoutExtTasks.tsx' ? read('popout/ext-tasks-model.ts') : read(file)
      expect(source, file).toContain('taskTextSource')
      for (const slot of slots) {
        const use = uses.find((u) => typeof u.attrs.text === 'string' && matches(u.attrs.text, slot.text))
        expect(use, `${file}: a slot rendering ${String(slot.text)}`).toBeTruthy()
        expect(use!.spreads.some((s) => matches(s, slot.source)), `${file}:${use!.line} source ${String(slot.source)} (got ${use!.spreads.join(' | ') || 'none'})`).toBe(true)
        expect('task' in use!.attrs, `${file}:${use!.line}`).toBe(false)
      }
    }
  })

  it('no status slot takes its source from the task\'s live session', () => {
    for (const file of Object.keys(SLOTS)) {
      for (const u of agentTextUses(read(file), path.join(WEB, file))) {
        const exprs = [...u.spreads, ...Object.values(u.attrs).filter((v): v is string => typeof v === 'string')]
        for (const e of exprs) expect(e, `${file}:${u.line}`).not.toMatch(/resolveTaskSessionId|\bsession_ids?\b|exec_session_id/)
      }
    }
    // The taskbar's status line is the task's words; only its last reply is the session's.
    const taskbar = agentTextUses(read('components/sessions/SessionTaskbar.tsx'), path.join(WEB, 'components/sessions/SessionTaskbar.tsx'))
    expect(taskbar.find((u) => u.attrs.text === 'line')!.attrs.sessionId).toBeUndefined()
    expect(taskbar.find((u) => u.attrs.text === 'lastReply')!.attrs.sessionId).toBe('sessionId')
    // The extension's fetched message names the session it was read from, not the task's now.
    expect(read('popout/PopoutExtTasks.tsx')).toContain('{ sessionId: last.sessionId }')
  })

  it('taskTextSource reads only stored writers, never the task\'s current session', () => {
    const src = read('utils/agent-text-source.ts')
    const start = src.indexOf('export function taskTextSource(')
    expect(start).toBeGreaterThan(0)
    const body = src.slice(start)
    // last_words.session_id is a stored writer; the task's own session fields are who runs now.
    expect(body).not.toMatch(/resolveTaskSessionId|\bt(?:ask)?\.session_ids?\b|exec_session_id|plan_session_id|\btask: t\b/)
    // An unknown writer is not filled from a task: sourceHostOf checks it before any task session.
    const host = src.slice(src.indexOf('export function sourceHostOf('), src.indexOf('/** The session the source names'))
    expect(host.indexOf('src.unknownSource')).toBeGreaterThan(0)
    expect(host.indexOf('src.unknownSource')).toBeLessThan(host.indexOf('resolveTaskSessionId'))
  })
})
