/**
 * What the person reads to decide an approval: why it is asked, the task it is for and where that
 * task stands, and the asking session's last steps before it asked (2026-11-07, the user: "but how
 * do I know which session is this so that I can have some context?"). Walnut reads it once, when
 * the request is made, from the asking session's own transcript, so a script needs to do nothing.
 *
 * A request from outside any session (a terminal, cron) has none of this: each part it cannot know
 * stays absent, and the screen says so ("Session: unknown"), never a blank (2026-11-07, the user:
 * "if some is missing at least we know some info, it will still work, but will show xx is unknown").
 */

export interface AskerStep {
  /** ran: a shell command; edited: a file it wrote; said: its own words; tool: any other tool. */
  kind: 'ran' | 'edited' | 'said' | 'tool'
  text: string
}

export interface AskerContext {
  /** Why it asks: the asker's own --why, else the session's last words before it asked. */
  why?: string
  whyFrom?: 'asker' | 'session'
  /** The task's goal in a sentence, and its project. */
  goal?: string
  project?: string
  /** The session's last steps before it asked, oldest first, at most ASKER_STEPS. */
  steps?: AskerStep[]
  /** What the step does and why, written by Walnut when the asker gave no why (summary.ts); shown on top. */
  summary?: string
}

export const ASKER_STEPS = 3
/** Two lines of the card. */
export const WHY_MAX = 200
const STEP_MAX = 120
const GOAL_MAX = 160

type Row = { role: string; text: string; kind?: string; detail?: string }

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** Cut to max characters on a word, with an ellipsis. Pure. */
export function cutTo(s: string, max: number): string {
  const t = oneLine(s)
  if (t.length <= max) return t
  const head = t.slice(0, max - 1)
  const sp = head.lastIndexOf(' ')
  return `${(sp > max * 0.6 ? head.slice(0, sp) : head).trimEnd()}…`
}

/** The end of a message, where a turn says what it is about to do. Pure. */
function lastWordsOf(text: string): string {
  const t = oneLine(text)
  if (t.length <= WHY_MAX) return t
  // The last sentences that fit, so the line starts at a sentence, not mid-word.
  const tail = t.slice(-WHY_MAX)
  const at = tail.search(/[.!?。！？]\s+\S/)
  return at >= 0 && at < WHY_MAX * 0.7 ? tail.slice(at + 1).trim() : `…${tail.slice(tail.indexOf(' ') + 1)}`
}

/** The tool call that made the request itself: never one of the steps before it. */
function isApprovalCall(r: Row): boolean {
  if (r.kind !== 'tool') return false
  if (/approval_request|approval_wait/.test(r.text)) return true
  return /\bwalnut\b[^\n]*\b(approve|approval_request)\b/.test(r.detail ?? '')
}

function stepOf(r: Row): AskerStep | null {
  if (r.kind === 'tool') {
    const name = r.text.trim()
    const detail = oneLine(r.detail ?? '')
    if (/^(Bash|shell|exec|run_command|terminal)$/i.test(name)) return detail ? { kind: 'ran', text: cutTo(detail, STEP_MAX) } : null
    if (/^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|edit_file|write_file)$/i.test(name)) return { kind: 'edited', text: cutTo(detail || name, STEP_MAX) }
    const short = name.replace(/^mcp__[^_]+__/, '')
    return { kind: 'tool', text: cutTo(detail ? `${short} ${detail}` : short, STEP_MAX) }
  }
  if (r.role === 'assistant' && !r.kind && r.text.trim()) return { kind: 'said', text: cutTo(r.text, STEP_MAX) }
  return null
}

/** Why and the last steps, from the transcript rows up to the request. Pure. */
export function contextFromRows(rows: readonly Row[] | undefined, why?: string): Pick<AskerContext, 'why' | 'whyFrom' | 'steps'> {
  const out: Pick<AskerContext, 'why' | 'whyFrom' | 'steps'> = {}
  const given = why ? oneLine(why) : ''
  if (given) { out.why = cutTo(given, WHY_MAX); out.whyFrom = 'asker' }
  if (!rows?.length) return out
  // The rows before the request: from the end, past the call that asked (it may still be running).
  let end = rows.length
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 6); i--) {
    if (isApprovalCall(rows[i]!)) { end = i; break }
  }
  const before = rows.slice(0, end)
  const steps: AskerStep[] = []
  for (let i = before.length - 1; i >= 0 && steps.length < ASKER_STEPS; i--) {
    const r = before[i]!
    if (r.role === 'user') break // the turn that asked starts here
    const s = stepOf(r)
    if (s) steps.unshift(s)
  }
  if (steps.length) out.steps = steps
  if (!given) {
    const said = [...before].reverse().find((r) => r.role === 'assistant' && !r.kind && r.text.trim())
    if (said) { out.why = lastWordsOf(said.text); out.whyFrom = 'session' }
  }
  return out
}

/** The first sentence of a task's description, else of its summary. Pure. */
export function goalOf(task: { description?: string; summary?: string } | null | undefined): string | undefined {
  for (const raw of [task?.description, task?.summary]) {
    const t = oneLine((raw ?? '').replace(/[#*_`>]/g, ' '))
    if (!t) continue
    const m = /^(.+?[.!?。！？])(\s|$)/.exec(t)
    return cutTo(m ? m[1]! : t, GOAL_MAX)
  }
  return undefined
}

/** How long reading the asking session's transcript may hold the request. */
const READ_MS = 2_500

/**
 * The context for a request from a session of a task; `why` is the asker's own. Bounded and never
 * throws: a part it cannot read in time stays absent.
 */
export async function readAskerContext(input: { sessionId?: string; taskId?: string; why?: string }): Promise<AskerContext> {
  const ctx: AskerContext = {}
  let rows: Row[] | undefined
  if (input.sessionId) {
    // One deadline for the whole read: the live projection, else the stored transcript.
    const sid = input.sessionId
    const read = (async () => {
      const projection = await import('../session-projection.js')
      const live = await projection.buildSessionTranscript(sid).catch(() => undefined)
      return (live as { messages?: Row[] } | undefined)?.messages
        ?? ((await projection.readSessionTranscript(sid).catch(() => undefined)) as { messages?: Row[] } | undefined)?.messages
    })().catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    rows = await Promise.race([
      read,
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), READ_MS); timer.unref?.() }),
    ]).finally(() => clearTimeout(timer))
  }
  Object.assign(ctx, contextFromRows(rows, input.why))
  if (input.taskId) {
    try {
      const { getTask } = await import('../task-manager.js')
      const task = await getTask(input.taskId)
      const goal = goalOf(task as { description?: string; summary?: string })
      if (goal) ctx.goal = goal
      if (task?.project) ctx.project = task.project
    } catch { /* absent */ }
  }
  return ctx
}

/** The context as plain lines, for a signed envelope's context_summary and a notice. Pure. */
export function contextSummary(ctx: AskerContext): string {
  const lines: string[] = []
  if (ctx.why) lines.push(`Why (${ctx.whyFrom === 'asker' ? 'given' : 'its last words'}): ${ctx.why}`)
  if (ctx.goal) lines.push(`Goal: ${ctx.goal}`)
  if (ctx.project) lines.push(`Project: ${ctx.project}`)
  for (const s of ctx.steps ?? []) lines.push(`${s.kind === 'ran' ? 'Ran' : s.kind === 'edited' ? 'Edited' : s.kind === 'said' ? 'Said' : 'Used'}: ${s.text}`)
  return lines.join('\n')
}
