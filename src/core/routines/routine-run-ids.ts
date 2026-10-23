/**
 * The ids a host gives a claude-code routine run it starts while this Mac is away
 * (clock-host-start-v1), derived the same way here: the daemon's own derivation
 * (providers/clock-host-start-core.ts idsOf), so the two can never drift.
 *
 * This Mac asks before it runs a slot the host reports as owed: a host whose
 * "started" mark a daemon death cut may have started that slot already, and once
 * this Mac adopted the run from the journal (always before it acks it), the
 * session is here under the derived id. Then the slot is recorded, not run twice.
 */
import crypto from 'node:crypto';
import { WALNUT_HOME } from '../../constants.js';
import { createClockHostStart, type ClockHostStartDeps, type RoutineRunIds } from '../../providers/clock-host-start-core.js';

const derive = createClockHostStart({
  sha256: (text: string) => crypto.createHash('sha256').update(text).digest('hex'),
} as unknown as ClockHostStartDeps);

export function routineRunIdsOf(jobId: string, slotMs: number, home: string = WALNUT_HOME): RoutineRunIds {
  return derive.idsOf(home, jobId, slotMs);
}

/** The session id of the slot's run when a host started it and this Mac holds its session; else null. */
export async function hostStartedRunOf(jobId: string, slotMs: number): Promise<string | null> {
  const { sid } = routineRunIdsOf(jobId, slotMs);
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  return (await getSessionByClaudeId(sid)) ? sid : null;
}
