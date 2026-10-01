/**
 * MS To-Do phase mappings — owned by the ms-todo plugin.
 */
import type { TaskPhase } from '../../core/types.js';

type MSTodoStatus = 'notStarted' | 'inProgress' | 'completed';

export const PHASE_TO_MS_STATUS: Record<TaskPhase, MSTodoStatus> = {
  TODO: 'notStarted',
  // Parked work is not started as far as To Do can tell; the exact phase rides
  // the body's `Phase:` header, so a pull on the same version keeps WAITING.
  WAITING: 'notStarted',
  IN_PROGRESS: 'inProgress',
  NEED_ACTION: 'inProgress',
  COMPLETE: 'completed',
};

export const MS_STATUS_TO_DEFAULT_PHASE: Record<string, TaskPhase> = {
  notStarted: 'TODO',
  inProgress: 'IN_PROGRESS',
  completed: 'COMPLETE',
};

export function phaseToMsStatus(phase: TaskPhase): MSTodoStatus {
  return PHASE_TO_MS_STATUS[phase] ?? 'notStarted';
}

export function phaseFromMsStatus(msStatus: string): TaskPhase {
  return MS_STATUS_TO_DEFAULT_PHASE[msStatus] ?? 'TODO';
}
