/**
 * The registry of org-node duties (types.ts says what one is). Add a duty by writing
 * `<id>.duty.ts` beside this file and listing its manifest here; nothing else lists them.
 */
import { log } from '../../../logging/index.js';
import type { OrgDuty } from './types.js';
import { reflectionDuty } from './reflection.duty.js';

export const DUTY_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;

export const ORG_DUTIES: readonly OrgDuty[] = [
  reflectionDuty,
];

export function orgDuty(id: string): OrgDuty | undefined {
  return ORG_DUTIES.find((c) => c.id === id);
}

/** The registry as a client reads it: no functions. */
export function dutyList(): Array<Pick<OrgDuty, 'id' | 'name' | 'description' | 'roles'>> {
  return ORG_DUTIES.map(({ id, name, description, roles }) => ({ id, name, description, roles: [...roles] }));
}

let stops: Array<() => void> | null = null;

/**
 * Start every duty's runner once (the primary's boot). Idempotent; one that throws is logged
 * and skipped. An ephemeral server holds a copy of the user's data, switches included, and its
 * runners would spend model calls and message its copied sessions: it starts them only when asked
 * (WALNUT_DUTIES_ON_EPHEMERAL=1, a replay or a demo).
 */
export function startOrgDuties(opts: { ephemeral?: boolean } = {}): void {
  if (stops) return;
  if (opts.ephemeral && process.env.WALNUT_DUTIES_ON_EPHEMERAL !== '1') return;
  // Tests set it to '0' (tests/setup/runtime-dir-isolation.ts): a test server never runs a duty's clock.
  if (process.env.WALNUT_ORG_DUTIES === '0') return;
  stops = [];
  for (const cap of ORG_DUTIES) {
    try {
      const stop = cap.start?.();
      if (typeof stop === 'function') stops.push(stop);
    } catch (err) {
      log.task.warn('org duty did not start', { duty: cap.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

export function stopOrgDuties(): void {
  for (const stop of stops ?? []) {
    try { stop(); } catch { /* a stop never blocks the others */ }
  }
  stops = null;
}
