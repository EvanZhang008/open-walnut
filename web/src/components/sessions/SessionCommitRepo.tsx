/**
 * One repository in the commit view: its files and hunks with checkboxes, the
 * message box, Commit, then Push / Open PR behind an inline confirm, and the
 * running job's progress, hook output and result. See SessionCommitDialog.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEvent } from '@/hooks/useWebSocket';
import { ApiError } from '@/api/client';
import { fetchCommitJob, type CommitAction, type CommitHunk, type CommitJob, type CommitPlanFile, type CommitPlanRepo } from '@/api/session-commit';
import {
  buildSelections, defaultSelection, fileCheckState, fileKindNote, fileOwnerLabel, hunkDiffLines,
  errorText, hunkOwnerLabel, isSplittable, reasonNote, selectedCount, selectedDiffText, stepLabel, toggleFile, toggleHunk,
  type RepoSelection,
} from '@/components/sessions/sessionCommitModel';
import { log } from '@/utils/log';

const HUNK_PREVIEW_LINES = 40;
const POLL_MS = 2_000;

/** Follow one job: WS events first, a slow GET poll while it runs as the fallback. */
function useCommitJob(sessionId: string, initial: CommitJob | null) {
  const [job, setJob] = useState<CommitJob | null>(initial);
  const ref = useRef(job);
  ref.current = job;
  const accept = (next: CommitJob) => {
    const cur = ref.current;
    if (!cur || next.id !== cur.id) return;
    if (cur.state !== 'running' && next.state === 'running') return; // a late frame
    if (next.updatedAt < cur.updatedAt) return;
    ref.current = next;
    setJob(next);
  };
  useEvent('git-commit:job', (data) => {
    const d = data as { sessionId?: string; job?: CommitJob } | null;
    if (d?.job && d.sessionId === sessionId) accept(d.job);
  });
  const runningId = job?.state === 'running' ? job.id : null;
  useEffect(() => {
    if (!runningId) return;
    let cancelled = false;
    const t = setInterval(() => {
      fetchCommitJob(sessionId, runningId).then((j) => { if (!cancelled) accept(j); }).catch((err) => {
        // The server forgot the job (it restarted): say so instead of spinning forever.
        if (cancelled || !(err instanceof ApiError) || err.status !== 404) return;
        const cur = ref.current;
        if (!cur || cur.id !== runningId || cur.state !== 'running') return;
        const lost: CommitJob = { ...cur, state: 'failed', updatedAt: Date.now(), error: { code: 'lost', message: 'Walnut restarted while this ran. Check the repository before trying again.' } };
        ref.current = lost;
        setJob(lost);
      });
    }, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, runningId]);
  const begin = (j: CommitJob) => { ref.current = j; setJob(j); };
  return { job, begin };
}

function OwnerBadge({ label, owner }: { label: string; owner: string }) {
  return <span className={`scd-owner scd-owner-${owner}`}>{label}</span>;
}

function HunkView({ hunk, checked, onToggle }: { hunk: CommitHunk; checked: boolean; onToggle: () => void }) {
  const [full, setFull] = useState(false);
  const lines = hunkDiffLines(hunk);
  const shown = full ? lines : lines.slice(0, HUNK_PREVIEW_LINES);
  return (
    <div className={`scd-hunk scd-hunk-${hunk.owner}`} data-testid="scd-hunk" data-owner={hunk.owner} data-checked={checked ? '1' : '0'}>
      <label className="scd-hunk-head">
        <input type="checkbox" checked={checked} onChange={onToggle} aria-label={`Include the change at line ${hunk.newStart + 1}`} />
        <span className="scd-hunk-pos">Line {hunk.newStart + 1}</span>
        <span className="scd-stat"><span className="scd-add">+{hunk.newLines.length}</span> <span className="scd-del">-{hunk.oldLines.length}</span></span>
        <OwnerBadge label={hunkOwnerLabel(hunk.owner)} owner={hunk.owner} />
      </label>
      <pre className="scd-diff">
        {shown.map((l, i) => (
          <div key={i} className={`scd-line scd-line-${l.sign === '+' ? 'add' : l.sign === '-' ? 'del' : 'ctx'}`}>
            <span className="scd-sign">{l.sign}</span>{l.text || ' '}
          </div>
        ))}
      </pre>
      {!full && lines.length > HUNK_PREVIEW_LINES && (
        <button type="button" className="scd-link" onClick={() => setFull(true)}>Show {lines.length - HUNK_PREVIEW_LINES} more lines</button>
      )}
    </div>
  );
}

function FileRow({ file, sel, onSel }: { file: CommitPlanFile; sel: RepoSelection; onSel: (next: RepoSelection) => void }) {
  const splittable = isSplittable(file);
  const [open, setOpen] = useState(file.owner === 'mixed');
  const state = fileCheckState(file, sel);
  const cb = useRef<HTMLInputElement>(null);
  useEffect(() => { if (cb.current) cb.current.indeterminate = state === 'some'; }, [state]);
  const chosen = sel.get(file.path);
  const note = fileKindNote(file) ?? (file.session ? reasonNote(file.reason) : null);
  return (
    <div className="scd-file" data-testid="scd-file" data-path={file.path} data-owner={file.owner} data-state={state}>
      <div className="scd-file-head">
        <input ref={cb} type="checkbox" checked={state === 'all'} onChange={() => onSel(toggleFile(file, sel))} aria-label={`Include ${file.path}`} />
        {splittable
          ? <button type="button" className="scd-disclose" aria-expanded={open} aria-label={open ? 'Hide changes' : 'Show changes'} onClick={() => setOpen((o) => !o)}>{open ? '▾' : '▸'}</button>
          : <span className="scd-disclose-spacer" />}
        <span className={`scd-status-letter scd-st-${file.status}`}>{file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M'}</span>
        <span className="scd-path" title={file.path}>{file.path}</span>
        {splittable && <span className="scd-stat"><span className="scd-add">+{file.added ?? 0}</span> <span className="scd-del">-{file.removed ?? 0}</span></span>}
        {file.session && <OwnerBadge label={fileOwnerLabel(file.owner)} owner={file.owner} />}
      </div>
      {note && <div className="scd-file-note">{note}</div>}
      {open && splittable && (
        <div className="scd-hunks">
          {(file.hunks ?? []).map((h) => (
            <HunkView
              key={h.id}
              hunk={h}
              checked={chosen === 'whole' || (chosen instanceof Set && chosen.has(h.id))}
              onToggle={() => onSel(toggleHunk(file, h.id, sel))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function shortRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, '');
}

export function SessionCommitRepo(props: {
  sessionId: string;
  repo: CommitPlanRepo;
  initialJob: CommitJob | null;
  draft: string;
  onDraft: (text: string) => void;
  confirm: 'push' | 'pr' | null;
  onConfirm: (kind: 'push' | 'pr' | null) => void;
  onReload: () => void;
  onCommitted: () => void;
  startJob: (body: Record<string, unknown> & { action: CommitAction; repoRoot: string }) => Promise<CommitJob>;
  suggest: (diff: string, files: string[]) => Promise<string>;
}) {
  const { sessionId, repo, confirm, onConfirm } = props;
  const [sel, setSel] = useState<RepoSelection>(() => defaultSelection(repo));
  // A reloaded plan (after a commit, or Reload) starts again from the defaults.
  useEffect(() => { setSel(defaultSelection(repo)); }, [repo]);
  const [message, setMessage] = useState(props.draft);
  const [othersOpen, setOthersOpen] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const { job, begin } = useCommitJob(sessionId, props.initialJob);
  const [lastCommit, setLastCommit] = useState<{ sha: string; shortSha: string; subject: string; indexError?: string } | null>(null);
  const [lastPush, setLastPush] = useState<{ remote: string; ref: string; upToDate: boolean } | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);

  const sessionFiles = useMemo(() => repo.files.filter((f) => f.session), [repo]);
  const otherFiles = useMemo(() => repo.files.filter((f) => !f.session), [repo]);
  const counts = selectedCount(repo, sel);
  const running = job?.state === 'running';
  const blocked = repo.blocked;

  // React once to each job's end.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!job || job.state === 'running' || handled.current === job.id) return;
    handled.current = job.id;
    if (job.state !== 'succeeded') return;
    const r = job.result ?? {};
    if (job.action === 'commit') {
      setLastCommit({
        sha: String(r.sha ?? ''), shortSha: String(r.shortSha ?? ''), subject: String(r.subject ?? ''),
        ...(typeof r.indexError === 'string' ? { indexError: r.indexError } : {}),
      });
      setMessage('');
      props.onCommitted();
      props.onReload();
    } else if (job.action === 'push') {
      setLastPush({ remote: String(r.remote ?? ''), ref: String(r.ref ?? ''), upToDate: r.upToDate === true });
      props.onReload();
    } else if (job.action === 'pr') {
      setPrUrl(String(r.url ?? ''));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  const start = async (body: Record<string, unknown> & { action: CommitAction }) => {
    setRequestError(null);
    try {
      const j = await props.startJob({ ...body, repoRoot: repo.repoRoot });
      begin(j);
      log.info('session-commit', 'job started', { sessionId, jobId: j.id, action: body.action, repoRoot: repo.repoRoot });
    } catch (err) {
      setRequestError(errorText(err));
    }
  };

  const commit = () => {
    setLastCommit(null);
    setLastPush(null);
    setPrUrl(null);
    void start({ action: 'commit', branch: repo.branch, expectedHead: repo.headSha, message, selections: buildSelections(repo, sel) });
  };

  const suggest = async () => {
    const { diff, files } = selectedDiffText(repo, sel);
    setSuggesting(true);
    setRequestError(null);
    try {
      const text = await props.suggest(diff, files);
      setMessage(text);
      props.onDraft(text);
    } catch (err) {
      setRequestError(errorText(err));
    } finally {
      setSuggesting(false);
    }
  };

  const pushTarget = repo.upstream ?? repo.pushTarget;
  const canPush = !!repo.branch && !!repo.headSha && !!pushTarget && !blocked;
  const nothingToPush = !!repo.upstream && repo.ahead === 0;
  const canPr = repo.pr.available && !!repo.branch && !!repo.upstream && !blocked;
  const unpushed = !!repo.upstream && (repo.ahead ?? 0) > 0;
  const subjectGuess = lastCommit?.subject || message.split('\n')[0] || '';

  return (
    <section className="scd-repo" data-testid="scd-repo" data-repo={repo.repoRoot}>
      <div className="scd-repo-head">
        <span className="scd-repo-label" title={repo.repoRoot}>{repo.label || repo.repoRoot}</span>
        {repo.branch && <span className="scd-branch">on {repo.branch}</span>}
        {repo.upstream && repo.ahead != null && repo.ahead > 0 && <span className="scd-ahead">{repo.ahead} to push</span>}
        {repo.upstream && repo.behind != null && repo.behind > 0 && <span className="scd-behind" title="Pull or rebase before pushing">{repo.behind} behind {repo.upstream.remote}</span>}
      </div>
      {blocked && <div className="scd-blocked" data-testid="scd-blocked">{blocked.message}</div>}

      {sessionFiles.length === 0
        ? <div className="scd-muted">Nothing this session changed is left uncommitted here.</div>
        : <div className="scd-files">{sessionFiles.map((f) => <FileRow key={f.path} file={f} sel={sel} onSel={setSel} />)}</div>}

      {otherFiles.length > 0 && (
        <div className="scd-others">
          <button type="button" className="scd-link" aria-expanded={othersOpen} onClick={() => setOthersOpen((o) => !o)}>
            {othersOpen ? '▾' : '▸'} {otherFiles.length}{repo.omitted ? '+' : ''} other change{otherFiles.length === 1 ? '' : 's'} in this repository, not from this session
          </button>
          {othersOpen && <div className="scd-files">{otherFiles.map((f) => <FileRow key={f.path} file={f} sel={sel} onSel={setSel} />)}</div>}
        </div>
      )}

      <div className="scd-message-row">
        <textarea
          className="scd-message"
          data-testid="scd-message"
          placeholder="Commit message"
          value={message}
          rows={3}
          onChange={(e) => { setMessage(e.target.value); props.onDraft(e.target.value); }}
          disabled={running}
        />
        <button type="button" className="app-modal-btn scd-suggest" data-testid="scd-suggest" onClick={() => void suggest()} disabled={suggesting || running || counts.files === 0} title="Draft a message from the selected changes">
          {suggesting ? 'Drafting…' : '✦ Suggest'}
        </button>
      </div>

      <div className="scd-actions">
        <span className="scd-muted">{counts.files} file{counts.files === 1 ? '' : 's'} selected{counts.hunks ? `, ${counts.hunks} change${counts.hunks === 1 ? '' : 's'}` : ''}</span>
        <span className="scd-spacer" />
        {canPr && (
          <button type="button" className="app-modal-btn" data-testid="scd-pr" disabled={running || unpushed} title={unpushed ? 'Push your commits first' : undefined} onClick={() => { setPrTitle(subjectGuess); onConfirm('pr'); }}>
            Open PR
          </button>
        )}
        {canPush && (
          <button type="button" className="app-modal-btn" data-testid="scd-push" disabled={running || nothingToPush} title={nothingToPush ? 'Nothing to push' : undefined} onClick={() => onConfirm('push')}>
            Push
          </button>
        )}
        <button
          type="button"
          className="app-modal-btn primary"
          data-testid="scd-commit"
          disabled={running || !!blocked || counts.files === 0 || !message.trim()}
          title={counts.files === 0 ? 'Select something to commit' : !message.trim() ? 'Write a commit message' : undefined}
          onClick={commit}
        >Commit</button>
      </div>

      {confirm === 'push' && pushTarget && (
        <div className="scd-confirm" data-testid="scd-confirm" role="group" aria-label="Confirm push">
          <div>
            {repo.upstream
              ? <>Push <b>{repo.branch}</b> to <b>{pushTarget.remote}</b> as <b>{shortRef(pushTarget.ref)}</b>?</>
              : <>Push <b>{repo.branch}</b> to <b>{pushTarget.remote}</b> as <b>{shortRef(pushTarget.ref)}</b> and set it as the upstream?</>}
            {repo.upstream && repo.branch && shortRef(repo.upstream.ref) !== repo.branch && (
              <div className="scd-warn" data-testid="scd-push-other-name">Its upstream is a branch with another name.</div>
            )}
            {pushTarget.url && <div className="scd-muted scd-url">{pushTarget.url}</div>}
          </div>
          <div className="scd-confirm-actions">
            <button type="button" className="app-modal-btn" onClick={() => onConfirm(null)}>Cancel</button>
            <button type="button" className="app-modal-btn primary" data-testid="scd-confirm-ok" onClick={() => { onConfirm(null); void start({ action: 'push', branch: repo.branch, setUpstream: !repo.upstream }); }}>Push</button>
          </div>
        </div>
      )}
      {confirm === 'pr' && repo.upstream && (
        <div className="scd-confirm" data-testid="scd-confirm" role="group" aria-label="Confirm pull request">
          <div>Open a pull request from <b>{repo.branch}</b> on <b>{repo.upstream.remote}</b>?</div>
          <input className="app-modal-input" value={prTitle} onChange={(e) => setPrTitle(e.target.value)} placeholder="Title" aria-label="Pull request title" />
          <textarea className="scd-message" value={prBody} onChange={(e) => setPrBody(e.target.value)} placeholder="Description (optional)" rows={2} aria-label="Pull request description" />
          <div className="scd-confirm-actions">
            <button type="button" className="app-modal-btn" onClick={() => onConfirm(null)}>Cancel</button>
            <button type="button" className="app-modal-btn primary" data-testid="scd-confirm-ok" disabled={!prTitle.trim()} onClick={() => { onConfirm(null); void start({ action: 'pr', branch: repo.branch, title: prTitle, body: prBody }); }}>Open PR</button>
          </div>
        </div>
      )}

      {requestError && <div className="scd-error" data-testid="scd-error">{requestError}</div>}
      {job && (
        <div className={`scd-job scd-job-${job.state}`} data-testid="scd-job" data-state={job.state} data-action={job.action}>
          {job.state === 'running' && <div className="scd-muted">{stepLabel(job.step)}…</div>}
          {job.state === 'failed' && <div className="scd-error" data-testid="scd-error">{job.error?.message ?? 'Failed'}</div>}
          {job.state === 'succeeded' && job.action === 'commit' && lastCommit && (
            <div className="scd-ok" data-testid="scd-commit-ok">
              Committed <code data-testid="scd-commit-sha" title={lastCommit.sha}>{lastCommit.shortSha}</code> {lastCommit.subject}
              {lastCommit.indexError && (
                <div className="scd-warn">The git index could not be updated ({lastCommit.indexError}), so git status may list the committed files as staged changes.</div>
              )}
            </div>
          )}
          {job.state === 'succeeded' && job.action === 'push' && lastPush && (
            <div className="scd-ok" data-testid="scd-push-ok">{lastPush.upToDate ? 'Already up to date on' : 'Pushed to'} {lastPush.remote} {shortRef(lastPush.ref)}</div>
          )}
          {job.state === 'succeeded' && job.action === 'pr' && (
            <div className="scd-ok" data-testid="scd-pr-ok">{prUrl ? <a href={prUrl} target="_blank" rel="noreferrer">{prUrl}</a> : 'Pull request opened'}</div>
          )}
          {job.output && (job.state !== 'succeeded' || job.action !== 'commit') && (
            <pre className="scd-output" data-testid="scd-job-output">{job.output}</pre>
          )}
        </div>
      )}
    </section>
  );
}
