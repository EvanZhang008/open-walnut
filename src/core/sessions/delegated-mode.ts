import { SESSION_MODE_IDS, type SessionMode } from '../types.js';

/** A preapproved task_create cannot launch work with greater trust than its caller. */
export function delegatedMode(caller: SessionMode, requested?: string): SessionMode | undefined {
  if (!SESSION_MODE_IDS.includes(caller)) caller = 'default';
  if (caller === 'bypass') return requested as SessionMode | undefined;
  if (requested && SESSION_MODE_IDS.indexOf(requested as SessionMode) > SESSION_MODE_IDS.indexOf(caller)) {
    throw new Error(`A ${caller} session cannot start a task in ${requested} mode. Change the caller's mode first.`);
  }
  return (requested as SessionMode | undefined) ?? caller;
}
