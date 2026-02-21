import type { ReactNode } from 'react';
import type { TaskStatus, TaskPhase } from '@walnut/core';
import { PersonIcon } from './PersonIcon';

interface StatusBadgeProps {
  status: TaskStatus;
  phase?: TaskPhase;
}

const phaseSymbols: Record<string, ReactNode> = {
  TODO: '\u25CB',                    // ○ hollow circle
  IN_PROGRESS: '\u25D0',            // ◐ half-filled
  AGENT_COMPLETE: '\u2713',          // ✓ checkmark
  AWAIT_HUMAN_ACTION: <PersonIcon />,
  PEER_CODE_REVIEW: '\u22C8',       // ⋈ bowtie
  RELEASE_IN_PIPELINE: '\u25B7',    // ▷ open triangle
  COMPLETE: '\u2713\u2713',          // ✓✓ double check
};

const phaseLabels: Record<string, string> = {
  TODO: 'To Do',
  IN_PROGRESS: 'In Progress',
  AGENT_COMPLETE: 'Agent Complete',
  AWAIT_HUMAN_ACTION: 'Await Human Action',
  PEER_CODE_REVIEW: 'Peer Code Review',
  RELEASE_IN_PIPELINE: 'Release in Pipeline',
  COMPLETE: 'Complete',
};

const statusSymbols: Record<string, string> = {
  todo: '\u25CB',
  done: '\u25CF',
};

const statusLabels: Record<string, string> = {
  todo: 'Todo',
  done: 'Done',
};

export function StatusBadge({ status, phase }: StatusBadgeProps) {
  if (phase) {
    return (
      <span className={`badge badge-phase-${phase.toLowerCase()}`}>
        {phaseSymbols[phase] ?? '?'} {phaseLabels[phase] ?? phase}
      </span>
    );
  }
  return (
    <span className={`badge badge-${status}`}>
      {statusSymbols[status] ?? '?'} {statusLabels[status] ?? status}
    </span>
  );
}
