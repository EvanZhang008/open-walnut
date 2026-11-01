/**
 * The task menus' Sync row (the board's kebab and the session header's): where the task stands
 * against the outside service its project syncs to, collapsed to one line, and on click what
 * can change (2026-11-01, the user: "we can turn a task from [the tracker] to local, of the same
 * project"):
 *
 *   - a synced task: "Make local" with what happens to its copy there: keep it as it is, archive
 *     it, or neutralize it (title and text replaced, then archived);
 *   - a task kept local: why (the one line the server stores), "Sync to <service>", and for one
 *     turned local whose copy is still there, archive or neutralize that copy.
 *
 * Shown only for a task whose project syncs (or that syncs itself). Writes go to
 * /api/v1/tasks/:id/make-local | sync-to-project | outside-copy; the task row updates from the
 * task:updated event.
 */
import { useState } from 'react';
import type { SyncHold, Task } from '@open-walnut/core';
import { CHEVRON_GLYPH } from '@/components/common/Icons';
import { useIntegrations, getIntegrationMeta } from '@/hooks/useIntegrations';
import { useProjectRegistry } from '@/hooks/useProjectRegistry';
import { changeOutsideCopy, makeTaskLocal, syncTaskToProject, type OutsideCopyAction } from '@/api/private-tasks';
import { log } from '@/utils/log';
import { useOptionalNotifications } from '@/contexts/notifications/notification-context';
import { keptLine, syncStanding } from './private-task-model';
import '@/styles/subtask-pill.css';

const ICON_LOCK = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.3" />
    <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
  </svg>
);

type TaskLike = Pick<Task, 'id' | 'source' | 'project'> & { sync_hold?: SyncHold };

export function TaskSyncMenuRows({ task, afterAction, onError }: {
  task: TaskLike;
  /** Close the host menu. */
  afterAction: () => void;
  /** Show a failure the user should read; default a toast. Logged either way. */
  onError?: (message: string) => void;
}) {
  const integrations = useIntegrations();
  const { sourceByName } = useProjectRegistry();
  const [expanded, setExpanded] = useState(false);
  const notify = useOptionalNotifications()?.notify;
  const standing = syncStanding(task, sourceByName.get((task.project ?? '').trim().toLowerCase()));
  if (standing.kind === 'local') return null;
  const name = (source: string) => getIntegrationMeta(integrations, source)?.name ?? source;
  const service = name(standing.service);
  const run = (what: string, work: () => Promise<unknown>) => {
    log.info('tasks', `private tasks: ${what}`, { taskId: task.id });
    work().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('tasks', `private tasks: ${what} failed`, { taskId: task.id, error: message });
      if (onError) onError(message);
      else notify?.({ kind: 'operation-error', severity: 'warning', title: 'Sync not changed', body: message, persistent: false, dedupKey: `private-task-${task.id}` });
    });
    afterAction();
  };
  const makeLocal = (outside: OutsideCopyAction) => run(`make local (${outside})`, () => makeTaskLocal(task.id, outside));
  const outsideKept = standing.kind === 'kept' && standing.hold?.outside?.state === 'kept';
  const summary = standing.kind === 'synced' ? `Syncs to ${service}`
    : standing.kind === 'checking' ? 'Checking…'
    : `Local, not in ${service}`;
  const line = keptLine(standing, name);
  return (
    <>
      <div className="task-kebab-divider" />
      <div className={`task-kebab-team${expanded ? ' open' : ''}`} data-testid="kebab-sync" data-sync-kind={standing.kind}>
        <button
          type="button"
          className="task-kebab-item task-kebab-team-toggle"
          data-testid="kebab-sync-toggle"
          aria-expanded={expanded}
          title={line || summary}
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
        >
          <span className="task-kebab-icon">{ICON_LOCK}</span>
          <span className="task-kebab-team-label">Sync: <b>{summary}</b></span>
          <span className={`task-kebab-team-caret${expanded ? ' open' : ''}`} aria-hidden="true">{CHEVRON_GLYPH}</span>
        </button>
        {expanded && (
          <div className="task-kebab-team-rows" data-testid="kebab-sync-rows">
            {line && <div className="task-kebab-item task-kebab-info task-sync-line" data-testid="kebab-sync-line">{line}</div>}
            {standing.kind === 'synced' && (
              <>
                <button type="button" className="task-kebab-item" data-testid="kebab-make-local-keep"
                  title={`Stop syncing; its copy in ${service} stays as it is and is no longer updated`}
                  onClick={(e) => { e.stopPropagation(); makeLocal('keep'); }}>
                  <span>Make local, keep its copy in {service}</span>
                </button>
                <button type="button" className="task-kebab-item" data-testid="kebab-make-local-archive"
                  title={`Stop syncing and close its copy in ${service}`}
                  onClick={(e) => { e.stopPropagation(); makeLocal('archive'); }}>
                  <span>Make local, archive it in {service}</span>
                </button>
                <button type="button" className="task-kebab-item" data-testid="kebab-make-local-neutralize"
                  title={`Stop syncing, replace its title and text in ${service} with nothing of the task, then close it`}
                  onClick={(e) => { e.stopPropagation(); makeLocal('neutralize'); }}>
                  <span>Make local, neutralize it in {service}</span>
                </button>
              </>
            )}
            {standing.kind !== 'synced' && (
              <button type="button" className="task-kebab-item" data-testid="kebab-sync-to-project"
                title={`Send this task to ${service} now`}
                onClick={(e) => { e.stopPropagation(); run('sync to project', () => syncTaskToProject(task.id)); }}>
                <span>Sync to {service}</span>
              </button>
            )}
            {outsideKept && (
              <>
                <button type="button" className="task-kebab-item" data-testid="kebab-outside-archive"
                  title={`Close the copy it left in ${service}`}
                  onClick={(e) => { e.stopPropagation(); run('archive outside copy', () => changeOutsideCopy(task.id, 'archive')); }}>
                  <span>Archive its copy in {service}</span>
                </button>
                <button type="button" className="task-kebab-item" data-testid="kebab-outside-neutralize"
                  title={`Replace the title and text of the copy it left in ${service}, then close it`}
                  onClick={(e) => { e.stopPropagation(); run('neutralize outside copy', () => changeOutsideCopy(task.id, 'neutralize')); }}>
                  <span>Neutralize its copy in {service}</span>
                </button>
              </>
            )}
            {standing.kind === 'kept' && !standing.hold && (
              <button type="button" className="task-kebab-item" data-testid="kebab-keep-local"
                title="Mark it Local by choice: Walnut never offers it to the service"
                onClick={(e) => { e.stopPropagation(); makeLocal('keep'); }}>
                <span>Keep it local</span>
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
