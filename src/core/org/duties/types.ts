/**
 * A duty a node of the org (the CEO or a VP) can turn on for itself: one switch per
 * duty in the node's own settings, off until someone turns it on (2026-11-19, the user:
 * "I think each VP, can turn on some duty, We need to make it generic"). Reflection over
 * the sessions a node manages is the first one (reflection.duty.ts).
 *
 * Every duty is one manifest file `<id>.duty.ts` in this folder, listed in
 * registry.ts: the switch, the route, the op and the settings panel all read the registry, so a
 * new duty needs no code of its own outside its manifest and what it runs
 * (tests/core/org/org-duties-registry.test.ts fails for a manifest the registry misses).
 */
import type { Task } from '../../types.js';

export type DutyRole = 'main' | 'lead';

export interface OrgDuty {
  /** Stable key, stored on the node (Task.org_duties[id]): lowercase letters, digits, dashes. */
  id: string;
  /** The switch's label, as the user reads it. */
  name: string;
  /** One or two sentences under the label: what turning it on does. */
  description: string;
  /** The nodes that may turn it on. */
  roles: readonly DutyRole[];
  /**
   * Started once on the primary at boot (startOrgDuties): it runs for every node that has
   * it on, reading the switch each time it acts, so a switch needs no restart. Returns its stop.
   */
  start?: () => (() => void) | void;
}

/** One node's switch for one duty, as stored. No row: off. */
export interface NodeDutyState {
  on: boolean;
  at: string;
  /** Who turned it: the user (none), an agent, or a task. */
  by?: 'human' | 'agent' | `task:${string}`;
  by_name?: string;
}

export type NodeDuties = NonNullable<Task['org_duties']>;
