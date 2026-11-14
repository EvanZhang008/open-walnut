/**
 * The leader's own row above the lanes while `Needs you` is on (spec 7.2):
 * `The leader: approve Bash`, so the entries in sight add up to the chip's
 * number (the leader counts in it). A prompt expands into the same in place
 * answer a card has (KanbanCardPrompt); any other reason opens the leader.
 */
import { useState } from 'react';
import { ICON_NEW_TAB } from '@/components/common/Icons';
import type { KanbanLeaderRowProps } from './kanban-contract';
import { KanbanCardPrompt } from './KanbanCardPrompt';
import { leaderReason } from './KanbanRollup';

export function KanbanLeaderRow({ leader, onOpenTask }: KanbanLeaderRowProps) {
  const [open, setOpen] = useState(false);
  const prompt = leader.status.prompt;
  const text = `The leader: ${leaderReason(leader.status.text)}`;
  return (
    <div className="kanban-leader-row" data-testid="kanban-leader-row" data-task-id={leader.taskId} data-tone={leader.status.tone}>
      <div className="kanban-leader-row-head">
        <span className="kanban-card-dot" aria-hidden />
        {prompt ? (
          <button
            type="button"
            className="kanban-leader-row-toggle"
            data-testid="kanban-leader-row-toggle"
            aria-expanded={open}
            title={leader.status.tooltip || text}
            onClick={() => setOpen((v) => !v)}
          >{text}</button>
        ) : (
          <button
            type="button"
            className="kanban-leader-row-toggle"
            data-testid="kanban-leader-row-toggle"
            title={leader.status.tooltip || text}
            onClick={() => onOpenTask(leader.taskId)}
          >{text}</button>
        )}
        <button
          type="button"
          className="kanban-icon-btn"
          data-testid="kanban-leader-row-open"
          aria-label={`Open ${leader.title}`}
          title={`Open ${leader.title}`}
          onClick={() => onOpenTask(leader.taskId)}
        >{ICON_NEW_TAB}</button>
      </div>
      {open && prompt && (
        <div className="kanban-card-prompt" onPointerDown={(e) => e.stopPropagation()}>
          <KanbanCardPrompt request={prompt} onAnswered={() => undefined} />
        </div>
      )}
    </div>
  );
}
