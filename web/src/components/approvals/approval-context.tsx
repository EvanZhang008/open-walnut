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


/** A signed Git operation's own fields (the Git gate's context, `walnut-git-operation-v1`), when the request carries one. */
export interface GitOperation { repository: string; operation?: string; branch?: string; commitSha?: string }

export function gitOperation(a: Approval): GitOperation | null {
  const { text, signed } = detailText(a);
  if (!signed || !text) return null;
  try {
    const c = JSON.parse(text) as Record<string, unknown>;
    if (c.version !== 'walnut-git-operation-v1' || typeof c.repository !== 'string' || !c.repository) return null;
    const ref = typeof c.remoteRef === 'string' ? c.remoteRef : undefined;
    return {
      repository: c.repository,
      operation: typeof c.operation === 'string' ? c.operation : undefined,
      branch: ref ? ref.replace(/^refs\/heads\//, '') : undefined,
      commitSha: typeof c.commitSha === 'string' ? c.commitSha : undefined,
    };
  } catch { return null; }
}

/** A path with its home folder said as `~` (`/Users/u`, `/home/u`, `/local/home/u`): the rest is what tells folders apart. */
export function shortPath(p: string): string {
  return p.replace(/^(?:\/local)?\/home\/[^/]+(?=\/|$)|^\/Users\/[^/]+(?=\/|$)|^\/root(?=\/|$)/, '~');
}

/** The second line: where it acts, said as a path (the repository and the branch it pushes to, else the folder it ran in) and the machine. */
function whereLine(a: Approval, git: GitOperation | null, hostName: string): { label: string; text: string } {
  const host = a.requester.local ? 'this computer' : hostName;
  if (git) return { label: 'Repo', text: `${shortPath(git.repository)}${git.branch ? ` → ${git.branch}` : ''} (${host})` };
  if (a.requester.cwd) return { label: 'Folder', text: `${shortPath(a.requester.cwd)} (${host})` };
  return { label: 'Host', text: host };
}

/**
 * The dialog's body (2026-11-12, the user on a Git push dialog: "I just need to know which task and
 * which path right.. this si confuing"): two lines read at a glance, the task that asked (a link)
 * and where it acts (the repo and branch, or the folder, and the machine), then the request's own
 * sentence when it says more than those two lines (a mail, a browser step, a script's question),
 * a warning only when one is due, and everything else (the command, what started it, the asker's
 * own line, the signed detail) in one Details fold, closed. One layout for every kind of approval.
 */
export function ApprovalContextRows({ a, hostName }: { a: Approval; hostName: string }) {
  const r = a.requester;
  const c = a.context ?? {};
  const git = gitOperation(a);
  const where = whereLine(a, git, hostName);
  const command = r.command || r.ranBy;
  const outside = [r.process ? `run by ${r.process}` : '', r.user ? `as ${r.user}` : ''].filter(Boolean).join(' ');
  const detail = detailText(a);
  // A Git push's sentence ("Push commit … to origin mainline in meta-fresh") says again what the Repo line says.
  const asks = git && git.operation === 'push' && git.branch ? '' : a.what;
  const why = c.why && c.whyFrom !== 'session' ? c.why : '';
  return (
    <div className="approval-context" data-testid="approval-context">
      <div className="approval-row" data-testid="approval-task">
        <span className="approval-row-label">Task</span>
        <span className="approval-row-value">
          {r.taskId
            ? <AskerLink a={a} label={r.taskTitle || 'Its task'} />
            : <span className="approval-unknown">{`A script with no task${outside ? `, ${outside}` : ''}`}</span>}
        </span>
      </div>
      <div className="approval-row" data-testid="approval-where">
        <span className="approval-row-label">{where.label}</span>
        <span className="approval-row-value approval-where" title={git?.repository ?? r.cwd}>{where.text}</span>
      </div>
      {asks ? (
        <div className="approval-row">
          <span className="approval-row-label">Asks</span>
          <span className="approval-row-value approval-asks" data-testid="approval-asks">{asks}</span>
        </div>
      ) : null}
      {r.taskId && r.identity === 'unverified' ? (r.check === 'outside' ? (
        <div className="approval-warn" data-testid="approval-outside" role="note">
          Not sent from inside this task’s session: the asking process runs outside it.
        </div>
      ) : (
        <div className="approval-unknown approval-unchecked" data-testid="approval-unchecked" role="note">
          Walnut could not check that this came from the task’s session.
        </div>
      )) : null}
      {command || why || detail.text ? (
        <details className="approval-detail approval-details" data-testid="approval-detail">
          <summary>Details</summary>
          <div className="approval-details-body">
            {/* The asker's own line (`walnut approve --why`); never the session's last words. */}
            {why ? <div className="approval-why" data-testid="approval-why">{why}</div> : null}
            {command ? (
              <div className="approval-part">
                <div className="approval-part-label">Command</div>
                <code className="approval-command" data-testid="approval-command">{command}</code>
                {/* What Walnut read from the process table, when it differs from the command the asker named
                    (a signed approval binds the real operation in its detail). */}
                {!a.singleUse && r.command && r.ranBy && r.ranBy !== r.command
                  ? <div className="approval-ran-by" data-testid="approval-ran-by" title="Read by Walnut from this machine’s process list">Started by <code>{r.ranBy}</code></div>
                  : null}
              </div>
            ) : null}
            {detail.text ? (
              <div className="approval-part">
                <div className="approval-part-label">{detail.signed ? 'Signed detail' : 'Detail'}</div>
                <pre className="approval-detail-text">{detail.text}</pre>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}
