/**
 * What a trigger check watched (mail, a pull request, a chat), as an agent reads it back from the
 * trigger ops: trigger_test's run and trigger_template_check's answer. The watched words ride one
 * outside-data envelope (core/outside-content.ts); the verdict Walnut and the daemon give (exit code,
 * wouldFire, newItemCount, error, `fire`) stays beside it, outside.
 *
 * trigger_template_check is also the stored check of every template trigger (`walnut trigger-check
 * <template> <params>`), which prints the answer as its contract line ({fire, items, state}): a frame
 * there would break every armed template trigger. That call never runs for a session: a check run
 * relays its calls as `external`, from every CLI and daemon version (trigger-check-core.ts, "Who a
 * check's `walnut` calls act for"; only its task-only host ops carry the trigger's token). So the
 * answer is framed for a session's call (an agent's MCP tool or `walnut tools call` in its shell, a
 * script it runs there) and plain for the check, a person, a plugin's own code and server code.
 * 2026-11-26 review M2: any agent could read the newest mails' senders, subjects and previews
 * through it, unframed.
 */
import { clipText, tailText } from './doc-page.js'
import type { OpCaller } from './registry.js'
import { agentReadsFramed } from './outside-answer.js'
import { frameOutsideData, isWalnutFramed, outsideDataOf } from '../core/outside-content.js'
import { TRIGGER_OUTSIDE_SOURCE } from '../core/routines/trigger-envelope.js'
import { isExternalCallerSid } from '../providers/gateway-core.js'
import { CHECK_CALLER_SID_PREFIX } from '../providers/trigger-check-core.js'

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

/** The fields of a test run that hold what the script printed; the rest is the verdict. */
export const TEST_RUN_OUTPUT_FIELDS = ['stdoutTail', 'stderrTail', 'parsed'] as const

/** The run's output framed under `output`; anything else of the answer as it was. */
export function framedTestRun<T>(body: T): T {
  const r = rec(body)
  if (!r.result || typeof r.result !== 'object') return body
  const run = rec(r.result)
  if (isWalnutFramed(run.output)) return body
  const output: Record<string, unknown> = {}
  const verdict: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(run)) {
    if ((TEST_RUN_OUTPUT_FIELDS as readonly string[]).includes(key)) output[key] = value
    else verdict[key] = value
  }
  return { ...r, result: { ...verdict, output: frameOutsideData(TRIGGER_OUTSIDE_SOURCE, output) } } as T
}

/** What trigger_test's answer keeps of each tail, from its end, and of the parsed object's items. */
const STDOUT_TAIL = 2_000
const STDERR_TAIL = 1_200
const ITEMS_SHOWN = 20
const INPUT_HEAD = 1_000
const STATE_MAX = 600

const tailOf = (v: unknown, max: number): unknown =>
  typeof v === 'string' ? tailText(v, max) : v

/** trigger_test's answer for an agent: the verdict whole, the tails and the parsed object short, the output framed. */
export function testedRun(result: unknown): unknown {
  const framed = framedTestRun(result)
  const r = rec(framed)
  if (!r.result) return framed
  const run = rec(outsideDataOf(rec(r.result).output))
  const parsed = run.parsed && typeof run.parsed === 'object' ? rec(run.parsed) : null
  const items = parsed && Array.isArray(parsed.items) ? parsed.items : []
  const state = parsed && 'state' in parsed ? JSON.stringify(parsed.state) ?? 'null' : ''
  const cut: string[] = []
  if (typeof run.stdoutTail === 'string' && run.stdoutTail.length > STDOUT_TAIL) cut.push(`stdout to its last ${STDOUT_TAIL} characters`)
  if (typeof run.stderrTail === 'string' && run.stderrTail.length > STDERR_TAIL) cut.push(`stderr to its last ${STDERR_TAIL} characters`)
  if (items.length > ITEMS_SHOWN) cut.push(`items to the first ${ITEMS_SHOWN} of ${items.length}`)
  if (typeof parsed?.input === 'string' && parsed.input.length > INPUT_HEAD) cut.push(`input to its first ${INPUT_HEAD} characters`)
  if (state.length > STATE_MAX) cut.push(`state (${state.length} characters of JSON)`)
  if (!cut.length) return framed
  const shortened = {
    ...run,
    stdoutTail: tailOf(run.stdoutTail, STDOUT_TAIL),
    stderrTail: tailOf(run.stderrTail, STDERR_TAIL),
    ...(parsed ? {
      parsed: {
        ...parsed,
        ...(items.length > ITEMS_SHOWN ? { items: items.slice(0, ITEMS_SHOWN), itemCount: items.length } : {}),
        ...(typeof parsed.input === 'string' && parsed.input.length > INPUT_HEAD ? { input: clipText(parsed.input, INPUT_HEAD) } : {}),
        ...(state.length > STATE_MAX ? { state: `(${state.length} characters of JSON)` } : {}),
      },
    } : {}),
  }
  return {
    ...r,
    result: { ...rec(r.result), output: frameOutsideData(TRIGGER_OUTSIDE_SOURCE, shortened) },
    shortened: `Shortened for this answer, nothing failed: ${cut.join('; ')}. Repeat the same trigger_test with "_full": true for all of it.`,
  }
}

/**
 * Whether this trigger_template_check call is a session's (framed), not the stored check's or a person's (plain).
 * The rule is agentReadsFramed (outside-answer.ts), the one every op uses, with one narrowing: this
 * answer is also the stored check's contract line, and the stored check runs on every CLI and daemon
 * version, most of which mark no `reader`. So a caller the general rule frames reads it framed only
 * when a model reads it for certain (`reader: 'model'`) or it names a session: an older check names
 * none (relayed as `external`, or with its own token), nor does a plugin's own code.
 */
export function templateCheckReadsFramed(caller: OpCaller | undefined): boolean {
  if (!agentReadsFramed(caller)) return false
  if (caller?.reader === 'model') return true
  const sid = caller?.sid?.trim()
  // A check run's own token never names a session either, should one ever reach here unrelayed.
  return !caller?.pluginId && !!sid && !isExternalCallerSid(sid) && !sid.startsWith(CHECK_CALLER_SID_PREFIX)
}

/** trigger_template_check's answer: `fire` beside one envelope of everything the plugin answered, for a session. */
export function framedTemplateCheck(answer: unknown, caller: OpCaller | undefined): unknown {
  if (!templateCheckReadsFramed(caller) || !answer || typeof answer !== 'object' || Array.isArray(answer) || isWalnutFramed(answer)) return answer
  const { fire, ...watched } = answer as Record<string, unknown>
  return frameOutsideData(TRIGGER_OUTSIDE_SOURCE, watched, undefined, typeof fire === 'boolean' ? { before: { fire } } : undefined)
}
