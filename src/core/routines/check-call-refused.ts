/**
 * A trigger check's Walnut call refused for its arguments is never read as "nothing yet".
 *
 * A check calls Walnut (`walnut tools call host_exec ...`) and decides from the answer whether to
 * fire. A call with arguments the op refuses never runs, and a script that drops its error
 * (`2>/dev/null | grep ...`) prints `fire: false` every time: the trigger stays armed, quiet and
 * blind. 2026-11-26 22:50Z to 11-27 07:55Z: one check called host_exec with `"timeout":15` (the key
 * is timeout_ms) every 15 minutes, 36 refusals, and it never saw the change it watched; it fired only
 * by its clock. Nobody heard: the refusal went back to a script that threw it away.
 *
 * The daemon vouches which trigger (or which test run) a check's call came from (`triggerCaller`,
 * read here as the host ops read it: trigger-caller.ts vouchedCheckCaller, so only a trigger that is
 * on, or a test run still going, of the host that relayed the call counts), and the relay that
 * answers it (capability-router.ts) hands such a refusal here:
 *   - an armed trigger's: the task whose session wrote the check hears it, once a day per trigger and
 *     op (trigger-health.ts);
 *   - a test run's: trigger_test's answer names it (trigger-api.ts, ops/triggers.ts), so the
 *     check is fixed before it is armed.
 * Only arguments the op refused count: a call that can never run as written. A designed refusal
 * (not found, a grant still asked) is an answer a check may wait through.
 */
import { log } from '../../logging/index.js'

export interface RefusedCall { op: string; message: string }

const MESSAGE_MAX = 600
/** A test run's refusals are read when its answer is built, within its time limit. */
const TEST_KEPT_MS = 15 * 60_000
const TESTS_MAX = 200
const PER_TEST_MAX = 5

const testRefusals = new Map<string, { at: number; calls: RefusedCall[] }>()

/** Walnut's refusal as told, its head kept (a refusal names its fix first). */
function clip(text: string): string {
  const t = text.trim()
  return t.length > MESSAGE_MAX ? `${t.substring(0, MESSAGE_MAX)} [rest left out]` : t
}

/** Keep a test run's refused call for its answer. */
function keepForTest(id: string, call: RefusedCall, now: number): void {
  for (const [k, v] of testRefusals) if (now - v.at > TEST_KEPT_MS) testRefusals.delete(k)
  const kept = testRefusals.get(id) ?? { at: now, calls: [] }
  if (!testRefusals.has(id) && testRefusals.size >= TESTS_MAX) return
  if (kept.calls.length < PER_TEST_MAX && !kept.calls.some((c) => c.op === call.op && c.message === call.message)) kept.calls.push(call)
  testRefusals.set(id, kept)
}

/** The calls a test run's check made that were refused for their arguments (empty for none). */
export function testRunRefusals(testId: string | undefined, now = Date.now()): RefusedCall[] {
  if (!testId) return []
  const kept = testRefusals.get(testId)
  return kept && now - kept.at <= TEST_KEPT_MS ? kept.calls.slice() : []
}

/**
 * A relayed call the op refused for its arguments, from a check the daemon vouched for: told to
 * whoever can fix the check. Never throws; the caller's own answer is unchanged.
 */
export async function noteCheckCallRefused(raw: unknown, host: string, op: string, message: string, now = Date.now()): Promise<void> {
  try {
    // Only a trigger, or a test run, of the host that relayed the call (trigger-caller.ts, as the host ops read it).
    const { vouchedCheckCaller } = await import('../hosts/trigger-caller.js')
    const check = await vouchedCheckCaller(raw, host, now)
    if (!check) return
    const call = { op, message: clip(message) }
    if (check.kind === 'test') { keepForTest(check.id, call, now); return }
    const { toldRecently, tellTriggerTeam, buildTriggerTroubleNotice } = await import('./trigger-health.js')
    if (toldRecently(`check-call-refused:${check.id}:${op}`, now)) return
    // The task whose session wrote the check: the one that can fix it.
    const told = await tellTriggerTeam({
      taskId: check.taskId, jobId: check.id, host, reach: 'team',
      text: (a) => buildTriggerTroubleNotice({
        jobId: check.id, jobName: check.name, title: 'Trigger check call refused', outcome: 'check_call_refused',
        body: `its check calls ${op} with arguments Walnut refuses, so that call never runs; a check that reads `
          + `the refusal as "nothing yet" never fires on what it watches. Walnut answered: ${call.message}`,
        next: `Fix that call in the check script, run trigger_test on it (its answer names a refused call), then change `
          + `trigger ${check.id} in place with trigger_update (same id, nothing it saw is lost).`,
      }, a),
    })
    log.cron.info('trigger check call refused: told', { jobId: check.id, op, told: told.to, toldTask: told.taskId })
  } catch (err) {
    log.cron.warn('trigger check call refused: telling failed', { op, error: err instanceof Error ? err.message : String(err) })
  }
}

export function _resetCheckCallRefusalsForTesting(): void { testRefusals.clear() }
