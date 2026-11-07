/**
 * Who asks and why, in the words the person decides on (2026-11-07, the user: "but how do I know
 * which session is this so that I can have some context?"): the asking task as a link, why it asks,
 * the task's goal, its last steps before it asked, what it runs and where, and whether Walnut saw
 * the asking process inside that session. Each part Walnut could not know says so ("Session:
 * unknown"), never a blank (the user: "if some is missing at least we know some info ... will show
 * xx is unknown").
 */
import { useNavigate } from 'react-router-dom';
import { openTaskOnHome } from '@/utils/open-session';
import { taskPath } from '@/utils/task-path';
import type { Approval } from '@/api/approvals';
import { closeApproval, openApproval } from './approvals-store';

/**
 * The task that asked, opened the way a task link opens it: on Home, selected, its session column
 * open, from any page or a full-screen sheet (2026-11-06, the user: "It doesn't make me able to
 * click and jump to that task"). An open dialog closes first; the card stays in its corner.
 */
export function useOpenAsker(): (a: Approval) => void {
  const navigate = useNavigate();
  return (a: Approval) => {
    if (!a.requester.taskId) { openApproval(a.id); return; }
    closeApproval();
    openTaskOnHome(a.requester.taskId, navigate);
  };
}

/** The asking task's name as a task link (a modifier click opens it in a new tab). */
export function AskerLink({ a, label }: { a: Approval; label: string }) {
  const openAsker = useOpenAsker();
  const id = a.requester.taskId!;
  return (
    <a className="task-link approval-task-link" data-task-id={id} data-testid="approval-task-link" href={taskPath(id)} title="Open the task that asked"
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault(); e.stopPropagation(); openAsker(a);
      }}><span className="approval-task-link-label">{label}</span><span className="approval-task-link-go" aria-hidden="true">&nbsp;↗</span></a>
  );
}

const STEP_WORD = { ran: 'Ran', edited: 'Edited', said: 'Said', tool: 'Used' } as const;

/** A signed approval's detail is its envelope: the person reads the context it carries. */
export function detailText(a: Approval): { text?: string; signed: boolean } {
  if (!a.detail) return { signed: false };
  if (a.singleUse) {
    try {
      const env = JSON.parse(a.detail) as { version?: string; context?: unknown };
      if (env.version === 'walnut-single-use-v1' && typeof env.context === 'string') return { text: env.context, signed: true };
    } catch { /* shown as it is */ }
  }
  return { text: a.detail, signed: false };
}

function sessionWord(a: Approval): string {
  const r = a.requester;
  if (!r.sessionId) return 'unknown';
  if (r.identity === 'unverified') {
    return r.check === 'outside'
      ? 'unverified: the asking process is not inside this session'
      : 'not checked: Walnut could not look at the asking process (it came through a host’s daemon, or the check timed out)';
  }
  return r.identity === 'verified' ? 'seen inside this task’s session' : 'this task’s session';
}

/** The dialog's rows: the whole request, every part named, the unknown ones too. */
export function ApprovalContextRows({ a, hostName }: { a: Approval; hostName: string }) {
  const r = a.requester;
  const c = a.context ?? {};
  const openAsker = useOpenAsker();
  const where = [c.project, `on ${hostName}`].filter(Boolean).join(' · ');
  const outside = [r.process ? `run by ${r.process}` : '', r.user ? `as ${r.user}` : ''].filter(Boolean).join(' ');
  return (
    <div className="approval-context" data-testid="approval-context">
      <dl className="approval-context-rows">
        <dt>Why</dt>
        <dd data-testid="approval-why" className={c.why ? '' : 'approval-unknown'}>
          {c.why ? <>{c.why}{c.whyFrom === 'session' && <span className="approval-context-from"> (its last words before it asked)</span>}</> : 'not given'}
        </dd>
        <dt>Task</dt>
        <dd data-testid="approval-task">
          {r.taskId
            ? <><AskerLink a={a} label={r.taskTitle || 'Its task'} /> <span className="approval-who-host">{where}</span></>
            : <span className="approval-unknown">unknown <span className="approval-context-from">{`(on ${hostName}${outside ? `, ${outside}` : ''})`}</span></span>}
        </dd>
        {r.taskId && (<>
          <dt>Goal</dt>
          <dd data-testid="approval-goal" className={c.goal ? '' : 'approval-unknown'}>{c.goal ?? 'unknown'}</dd>
        </>)}
        <dt>Session</dt>
        <dd data-testid="approval-session" className={r.sessionId && r.identity !== 'unverified' ? '' : 'approval-unknown'}>{sessionWord(a)}</dd>
        {c.steps?.length ? (<>
          <dt>Just before</dt>
          <dd>
            <ol className="approval-steps" data-testid="approval-steps">
              {c.steps.map((s, i) => <li key={i}><span className="approval-step-kind">{STEP_WORD[s.kind]}</span> <span className="approval-step-text">{s.text}</span></li>)}
            </ol>
          </dd>
        </>) : null}
        <dt>Runs</dt>
        <dd data-testid="approval-runs" className={r.command || r.ranBy ? '' : 'approval-unknown'}>
          {r.command ? <code className="approval-command" data-testid="approval-command">{r.command}</code> : null}
          {r.ranBy && r.ranBy !== r.command
            ? <code className="approval-command" data-testid="approval-ran-by" title="Read by Walnut from this machine’s process list">{r.ranBy}</code>
            : null}
          {!r.command && !r.ranBy ? 'not given' : null}
          {r.cwd ? <span className="approval-cwd">in {r.cwd}</span> : null}
        </dd>
      </dl>
      {r.taskId && (
        <button type="button" className="approval-link approval-open-chat" data-testid="approval-open-chat"
          title="Open its chat beside this request: ask or answer it there, then decide"
          onClick={() => openAsker(a)}>Open its chat ›</button>
      )}
    </div>
  );
}
