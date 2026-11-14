/**
 * The request in the few parts the person decides on (2026-11-11, the user: "summary, say clearly,
 * one sentence ... then is command to run ... 然后那个是哪一个 task 来的 ... 其他的就没必要吧"):
 * the asker's sentence on top (the dialog's body, ApprovalPrompts), then the command that runs,
 * the task that asked as a link, and the signed detail folded under them. What the session said
 * before it asked, its goal, its last steps and the folder are left out: they read as noise, and
 * the task link opens all of it.
 */
import { useOpenTask } from '@/hooks/useOpenTask';
import { taskPath } from '@/utils/task-path';
import type { Approval } from '@/api/approvals';

/**
 * The asking task's name as a task link: a click opens it the way every task link does, on Home
 * with its session column open, from any page or a full-screen sheet (2026-11-06, the user: "It
 * doesn't make me able to click and jump to that task"). An open dialog closes itself when a task
 * opens (ApprovalDialog); the card stays in its corner. A modifier click opens it in a new tab.
 */
export function AskerLink({ a, label }: { a: Approval; label: string }) {
  const openTask = useOpenTask();
  const id = a.requester.taskId!;
  const onClick = (e: React.MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault(); e.stopPropagation(); openTask(id);
  };
  return (
    <a className="task-link approval-task-link" data-task-id={id} data-testid="approval-task-link" href={taskPath(id)} title="Open the task that asked"
      onClick={onClick}><span className="approval-task-link-label">{label}</span><span className="approval-task-link-go" aria-hidden="true">&nbsp;↗</span></a>
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
export interface GitOperation { repository: string; operation?: string; remote?: string; branch?: string; commitSha?: string }

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
      remote: typeof c.remote === 'string' ? c.remote : undefined,
      branch: ref ? ref.replace(/^refs\/heads\//, '') : undefined,
      commitSha: typeof c.commitSha === 'string' ? c.commitSha : undefined,
    };
  } catch { return null; }
}

/** A path with its home folder said as `~` (`/Users/u`, `/home/u`, `/local/home/u`): the rest is what tells folders apart. */
export function shortPath(p: string): string {
  // Not a person's home: macOS's shared and guest folders, Homebrew's Linux prefix.
  return p.replace(/^(?:\/local)?\/home\/(?!linuxbrew(?:\/|$))[^/]+(?=\/|$)|^\/Users\/(?!(?:Shared|Guest)(?:\/|$))[^/]+(?=\/|$)|^\/root(?=\/|$)/, '~');
}

/** The machine a request came from, said for the person: this one is "this computer", another by its display name. */
export function hostWords(a: Approval, hostName: string): string {
  return a.requester.local ? 'this computer' : hostName;
}

/** The sentence the Git gate writes for a push (its own words for what the Repo line shows). */
function gatePushSentence(git: GitOperation): string {
  return `Push commit ${(git.commitSha ?? '').slice(0, 7)} to ${git.remote ?? ''} ${git.branch ?? ''} in ${git.repository.split('/').pop() ?? ''}`;
}

/** The second line: where it acts, said as a path (the repository and the branch it pushes to, else the folder it ran in) and the machine. */
function whereLine(a: Approval, git: GitOperation | null, hostName: string): { label: string; text: string } {
  const host = hostWords(a, hostName);
  if (git) return { label: 'Repo', text: `${shortPath(git.repository)}${git.branch ? ` → ${git.branch}` : ''} (${host})` };
  if (a.requester.cwd) return { label: 'Folder', text: `${shortPath(a.requester.cwd)} (${host})` };
  return { label: 'Host', text: host };
}

/**
 * The words on top of the dialog: what the step does and why, in full (2026-11-14, the user:
 * "Broi..... I need the summary AI write"). The asker's own line and its own why when it gave one;
 * else the summary Walnut wrote from the asking session (summary.ts on the server), with the
 * request's line under the two lines when it says more; until that arrives, the request's line.
 */
export function summaryOf(a: Approval): { text: string; by: 'walnut' | 'asker'; why?: string } {
  const c = a.context ?? {};
  if (c.summary && c.whyFrom !== 'asker') return { text: c.summary, by: 'walnut' };
  return { text: a.what, by: 'asker', ...(c.why && c.whyFrom === 'asker' ? { why: c.why } : {}) };
}

/**
 * The dialog's body (2026-11-12, the user on a Git push dialog: "I just need to know which task and
 * which path right.. this si confuing"): the summary on top, then two lines read at a glance, the
 * task that asked (a link) and where it acts (the repo and branch, or the folder, and the machine),
 * a warning only when one is due, and everything else (the command, what started it, the signed
 * detail) in one Details fold, closed. One layout for every kind of approval.
 */
export function ApprovalContextRows({ a, hostName }: { a: Approval; hostName: string }) {
  const r = a.requester;
  const c = a.context ?? {};
  const git = gitOperation(a);
  const where = whereLine(a, git, hostName);
  const command = r.command || r.ranBy;
  const outside = [r.process ? `run by ${r.process}` : '', r.user ? `as ${r.user}` : ''].filter(Boolean).join(' ');
  const detail = detailText(a);
  const summary = summaryOf(a);
  // Under Walnut's summary, the request's own line when it says more: the Git gate's push sentence
  // ("Push commit … to origin mainline in meta-fresh") says again what the Repo line says, so it is left out.
  const asks = summary.by === 'walnut' && a.what !== summary.text
    && !(git && git.operation === 'push' && git.branch && a.what === gatePushSentence(git)) ? a.what : '';
  // What Walnut read from the process table, when it differs from the command the asker named: a sign
  // of who really asks, so it stays above the fold (a signed approval binds the real operation instead).
  const ranByDiffers = !a.singleUse && !!r.command && !!r.ranBy && r.ranBy !== r.command;
  return (
    <div className="approval-context" data-testid="approval-context">
      <div className="approval-summary" data-testid="approval-dialog-summary" data-by={summary.by}>
        {/* The request's own line keeps its id (approval-asks); Walnut's summary says who wrote it. */}
        <p className={`approval-summary-text${summary.by === 'asker' ? ' approval-asks' : ''}`} data-testid={summary.by === 'asker' ? 'approval-asks' : 'approval-ai-summary'}>{summary.text}</p>
        {summary.why ? <p className="approval-summary-why" data-testid="approval-why">{summary.why}</p> : null}
        {summary.by === 'walnut' ? <span className="approval-summary-by" data-testid="approval-summary-by">Walnut’s summary of the task’s session, not signed: the lines below are what you approve</span> : null}
      </div>
      <div className="approval-field" data-testid="approval-task">
        <span className="approval-field-label">Task</span>
        <span className="approval-field-value">
          {r.taskId
            ? <AskerLink a={a} label={r.taskTitle || 'Its task'} />
            : <span className="approval-unknown">{`A script with no task${outside ? `, ${outside}` : ''}`}</span>}
        </span>
      </div>
      <div className="approval-field" data-testid="approval-where">
        <span className="approval-field-label">{where.label}</span>
        <span className="approval-field-value approval-where" title={git?.repository ?? r.cwd}>{where.text}</span>
      </div>
      {asks ? (
        <div className="approval-field">
          <span className="approval-field-label">Asks</span>
          <span className="approval-field-value approval-asks" data-testid="approval-asks">{asks}</span>
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
      {ranByDiffers ? (
        <div className="approval-warn approval-ran-by" data-testid="approval-ran-by" role="note" title="Read by Walnut from this machine’s process list">
          Started by <code>{r.ranBy}</code>, not by the command it names.
        </div>
      ) : null}
      {a.downgraded ? <div className="approval-note" data-testid="approval-downgraded">{a.downgraded}</div> : null}
      {command || detail.text ? (
        <details className="approval-detail approval-details" data-testid="approval-detail">
          <summary>Details</summary>
          <div className="approval-details-body">
            {command ? (
              <div className="approval-part">
                <div className="approval-part-label">Command</div>
                <code className="approval-command" data-testid="approval-command">{command}</code>
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
