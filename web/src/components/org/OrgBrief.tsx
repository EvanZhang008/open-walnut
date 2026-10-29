/**
 * The Brief: a short letter Main or a lead keeps for the user at the top of its chat, so they read
 * where things stand instead of scrolling the conversation. The session writes it at the end of
 * every turn (FOR_USER_BRIEF in its self-report, src/core/session-hooks/builtins.ts); Walnut keeps
 * the rest current: every task it names shows its live status, and what moved in the team since
 * it was written is listed under it. The user answers in the chat.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Task } from '@open-walnut/core';
import {
  briefMentions, briefMoves, briefStillOpen, resultIsPartial, USER_STATE_LABELS,
  type StillOpenAsk, type TaskBrief, type UserState,
} from '@open-walnut/user-status';
import { apiGet } from '@/api/client';
import { userStateOf } from '@open-walnut/org-tree';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { useEntityLabelsVersion } from '@/hooks/useEntityLabels';
import { timeAgo } from '@/utils/time';
import { decorateBriefHtml } from './org-brief-model';
import { BriefStillOpenList } from './BriefStillOpen';
import '@/styles/org-brief.css';

interface Props {
  owner: Task | undefined;
  tasks: readonly Task[];
  /** The owner's name, for the empty state. */
  name: string;
  onOpenTask: (id: string) => void;
  now: number;
  /** Folded: its first lines, the rest a click away. */
  folded?: boolean;
}

export function OrgBrief({ owner, tasks, name, onOpenTask, now, folded }: Props) {
  const brief = owner?.brief;
  const labels = useEntityLabelsVersion();
  const states = useMemo(() => new Map(tasks.map((t) => [t.id, userStateOf(t)] as const)), [tasks]);
  const partial = useMemo(() => new Set(tasks.filter((t) => resultIsPartial(t.result_report)).map((t) => t.id)), [tasks]);
  const markup = useMemo(
    () => (brief?.text ? decorateBriefHtml(renderMarkdownWithRefs(brief.text), states, partial) : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [brief?.text, states, partial, labels],
  );
  // React 19 resets innerHTML for every new {__html} object, even with the same string, which
  // drops a selection in the letter on any task update: keep one object per string.
  const html = useMemo(() => (markup ? { __html: markup } : null), [markup]);
  const moves = useMemo(
    () => (owner && brief?.at ? briefMoves(owner, tasks, Date.parse(brief.at)) : []),
    [owner, tasks, brief?.at],
  );
  const overdue = useOverdueAsks(!!owner);
  const stillOpen = useMemo(
    () => (owner && brief?.text ? briefStillOpen(owner, tasks, { mentioned: briefMentions(brief.text), overdue, now }) : null),
    [owner, tasks, brief?.text, overdue, now],
  );
  const issues = brief?.issues ?? [];
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('[data-task-id]');
    if (!a) return;
    e.preventDefault();
    onOpenTask(a.getAttribute('data-task-id')!);
  };

  if (!brief?.text || !html) {
    return (
      <div className="org-brief is-empty" data-testid="org-brief">
        <p className="org-muted">No brief yet. {name} writes one when its next turn ends.</p>
      </div>
    );
  }
  return (
    <div className={`org-brief${folded ? ' is-folded' : ''}`} data-testid="org-brief">
      <div className="org-brief-body markdown-body" data-testid="org-brief-body" onClick={onClick} dangerouslySetInnerHTML={html} />
      <div className="org-brief-foot" data-testid="org-brief-foot">
        <span className="org-muted">Written {timeAgo(brief.at, { now })}</span>
        {issues.length > 0 && (
          <span className="org-brief-issues" data-testid="org-brief-issues" title={issues.map((i) => i.line).join('\n')}>
            · {issues.length === 1 ? '1 line breaks' : `${issues.length} lines break`} the Brief rules ({issueWords(issues)}); Walnut asked {name} to fix {issues.length === 1 ? 'it' : 'them'}
          </span>
        )}
        {moves.length > 0 && (
          <span className="org-brief-moves" data-testid="org-brief-moves">
            <span className="org-muted"> · Since then:</span>
            {moves.map(({ task }) => (
              <button
                key={task.id}
                type="button"
                className="org-brief-move"
                data-task-id={task.id}
                data-user-state={states.get(task.id)}
                onClick={() => onOpenTask(task.id)}
                title={states.get(task.id) === 'done' ? '' : task.user_status?.ask ?? task.user_status?.waitingOn ?? task.user_status?.now ?? ''}
              >
                {task.title} <span className="org-muted">{stateWord(states.get(task.id))}</span>
              </button>
            ))}
          </span>
        )}
      </div>
      {stillOpen && <BriefStillOpenList open={stillOpen} tasks={tasks} states={states} now={now} onOpenTask={onOpenTask} />}
    </div>
  );
}

/** The overdue requests still open (GET /api/sessions/overdue-requests), refreshed every two minutes. */
function useOverdueAsks(on: boolean): StillOpenAsk[] {
  const [rows, setRows] = useState<StillOpenAsk[]>([]);
  useEffect(() => {
    if (!on) return;
    let live = true;
    const load = () => {
      apiGet<{ requests?: StillOpenAsk[] }>('/api/sessions/overdue-requests', undefined, { timeoutMs: 8_000, priority: 'low' })
        .then((r) => { if (live) setRows(Array.isArray(r?.requests) ? r.requests : []); })
        .catch(() => { /* an older server has no list: nothing overdue is shown */ });
    };
    load();
    const t = setInterval(load, 120_000);
    return () => { live = false; clearInterval(t); };
  }, [on]);
  return rows;
}

/** What the broken lines miss, in a few words: "no task, no VP". */
function issueWords(issues: NonNullable<TaskBrief['issues']>): string {
  const words = { no_task: 'no task', no_vp: 'no VP', several_things: 'several things in one line' } as const;
  return [...new Set(issues.map((i) => words[i.kind]))].join(', ');
}

function stateWord(state: UserState | undefined): string {
  return state ? USER_STATE_LABELS[state].toLowerCase() : '';
}
