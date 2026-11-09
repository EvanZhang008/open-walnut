/**
 * Mail's Routers group: each area's router, the central task its mail goes to first, with its live
 * state (Paused, Working, Needs you, Ready). A click opens the router's own node on the Org page.
 * With no router yet, one row offers to set one up there. Rows come from the shared task store, so
 * a pause or a turn shows here in the same frame as on the Org page.
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { useRouterAreaNames } from '@/components/org/router-area-names';
import { ORG_ROUTER_SETUP_PATH } from './MailRouterAssignment';
import { mailRouterRows } from './mail-router-rows';

export function MailRouterRows({ onPicked }: { onPicked: () => void }) {
  const navigate = useNavigate();
  const tasks = useTasksContextSafe()?.tasks;
  const ids = useMemo(() => (tasks ?? []).filter((t) => t.org_role === 'router').map((t) => t.router_area_id ?? ''), [tasks]);
  const areaNames = useRouterAreaNames(ids);
  const rows = useMemo(() => mailRouterRows(tasks ?? [], areaNames), [tasks, areaNames]);
  // No task store (a pop-out window): nothing to say rather than a wrong "none".
  if (!tasks) return null;
  const go = (path: string) => { navigate(path); onPicked(); };
  return (
    <section className="mail-routers" aria-label="Routers" data-testid="mail-routers">
      <p className="mail-smart-head">Routers</p>
      <ul className="mail-router-list">
        {rows.length === 0 && (
          <li>
            <button type="button" className="mail-mailbox mail-router-row" data-testid="mail-router-setup" tabIndex={0}
              title="Create a router in Org: it reads only the messages you choose for its area" onClick={() => go(ORG_ROUTER_SETUP_PATH)}>
              <span className="mail-router-name">Set up a router</span>
            </button>
          </li>
        )}
        {rows.map((r) => (
          <li key={r.taskId}>
            <button
              type="button"
              className="mail-mailbox mail-router-row"
              data-testid="mail-router-row"
              data-task-id={r.taskId}
              data-router-state={r.tone}
              tabIndex={0}
              title={`${r.name} · ${r.area} · ${r.state}. Opens it in Org.`}
              aria-label={`${r.name}, ${r.area}, ${r.state}. Open in Org`}
              onClick={() => go(r.path)}
            >
              <span className="mail-router-dot" data-tone={r.tone} aria-hidden="true" />
              <span className="mail-router-name">{r.name}</span>
              <span className="mail-router-state" data-testid="mail-router-state">{r.state}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
