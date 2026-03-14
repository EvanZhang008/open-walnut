/**
 * MS To-Do phase mappings — owned by the ms-todo plugin.
 */
import type { TaskPhase } from '../../core/types.js';

type MSTodoStatus = 'notStarted' | 'inProgress' | 'completed';

export const PHASE_TO_MS_STATUS: Record<TaskPhase, MSTodoStatus> = {
  TODO: 'notStarted',
  IN_PROGRESS: 'inProgress',
  AGENT_COMPLETE: 'inProgress',
  AWAIT_HUMAN_ACTION: 'inProgress',
  HUMAN_VERIFIED: 'inProgress',
  POST_WORK_COMPLETED: 'inProgress',
  PEER_CODE_REVIEW: 'inProgress',
  RELEASE_IN_PIPELINE: 'inProgress',
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
