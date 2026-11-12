/**
 * The request in the few parts the person decides on (2026-11-11, the user: "summary, say clearly,
 * one sentence ... then is command to run ... 然后那个是哪一个 task 来的 ... 其他的就没必要吧"):
 * the asker's sentence on top (the dialog's body, ApprovalPrompts), then the command that runs,
 * the task that asked as a link, and the signed detail folded under them. What the session said
 * before it asked, its goal, its last steps and the folder are left out: they read as noise, and
 * the task link opens all of it.
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

/** A signed approval's detail is its envelope: the person reads the context it carries, laid out when it is JSON. */
export function detailText(a: Approval): { text?: string; signed: boolean } {
  if (!a.detail) return { signed: false };
  let text = a.detail;
  let signed = false;
  if (a.singleUse) {
    try {
      const env = JSON.parse(a.detail) as { version?: string; context?: unknown };
      if (env.version === 'walnut-single-use-v1' && typeof env.context === 'string') { text = env.context; signed = true; }
    } catch { /* shown as it is */ }
  }
  return { text: prettyJson(text), signed };
}

/** A one-line JSON object or list, indented so its fields read one per line; any other text as it is. */
export function prettyJson(text: string): string {
  const t = text.trim();
  if (!(t.startsWith('{') && t.endsWith('}')) && !(t.startsWith('[') && t.endsWith(']'))) return text;
  try {
    const value = JSON.parse(t);
    // Laid out only when nothing is lost: a repeated key or a number past 2^53 shows as signed.
    return JSON.stringify(value) === t ? JSON.stringify(value, null, 2) : text;
  } catch { return text; }
}

/** The dialog's parts under the sentence: the command that runs, who asked, and a warning only when one is due. */
export function ApprovalContextRows({ a, hostName }: { a: Approval; hostName: string }) {
  const r = a.requester;
  const c = a.context ?? {};
  const command = r.command || r.ranBy;
  const where = r.local ? 'on this computer' : `on ${hostName}`;
  const outside = [r.process ? `run by ${r.process}` : '', r.user ? `as ${r.user}` : ''].filter(Boolean).join(' ');
  return (
    <div className="approval-context" data-testid="approval-context">
      {/* The asker's own line (`walnut approve --why`), one or two lines; never the session's last words. */}
      {c.why && c.whyFrom !== 'session' ? <div className="approval-why" data-testid="approval-why">{c.why}</div> : null}
      {command ? (
        <div className="approval-part">
          <div className="approval-part-label">Command</div>
          <code className="approval-command" data-testid="approval-command">{command}</code>
          {/* The asker names its command itself; what Walnut read from the process table shows
              beside it when they differ (a signed approval binds the real operation in its detail). */}
          {!a.singleUse && r.command && r.ranBy && r.ranBy !== r.command
            ? <div className="approval-ran-by" data-testid="approval-ran-by" title="Read by Walnut from this machine’s process list">Started by <code>{r.ranBy}</code></div>
            : null}
        </div>
      ) : null}
      <div className="approval-part" data-testid="approval-task">
        <div className="approval-part-label">Asked by</div>
        <div className="approval-part-value">
          {r.taskId
            ? <><AskerLink a={a} label={r.taskTitle || 'Its task'} /> <span className="approval-who-host">{where}</span></>
            : <span className="approval-unknown">{`A script with no task ${where}${outside ? `, ${outside}` : ''}`}</span>}
        </div>
      </div>
      {r.taskId && r.identity === 'unverified' ? (r.check === 'outside' ? (
        <div className="approval-warn" data-testid="approval-outside" role="note">
          Not sent from inside this task’s session: the asking process runs outside it.
        </div>
      ) : (
        <div className="approval-unknown approval-unchecked" data-testid="approval-unchecked" role="note">
          Walnut could not check that this came from the task’s session.
        </div>
      )) : null}
    </div>
  );
}
