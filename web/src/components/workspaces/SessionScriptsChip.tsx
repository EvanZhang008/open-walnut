/**
 * A session's "Scripts" chip (tool row, beside Terminal) and its menu: the
 * project's scripts and the repository's walnut.json, one click each. A click
 * opens the session's terminal and types the script there, in a subshell at
 * the workspace root (or the folder's git top), so its output, Ctrl-C and any
 * prompt are the user's (src/core/workspaces/script-line.ts).
 *
 * The list is read when the menu opens (the file lives on the session's host),
 * so an edit to walnut.json shows on the next open. "Edit scripts…" opens the
 * project's editor; "Run setup again" re-runs the workspace's setup as a job.
 *
 * The chip can sit in the row's "..." menu, which proxies a click to it: the
 * menu then opens under the "..." button, since the chip itself is not drawn.
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { ContextMenu, type ContextMenuItem, type ContextMenuPoint } from '@/components/common/ContextMenu';
import { fetchScripts, rerunTaskSetup, type ResolvedProjectScript, type ScriptsAnswer } from '@/api/workspaces';
import { useAlert } from '@/hooks/useConfirm';
import { useNotifications } from '@/contexts/notifications';
import { log } from '@/utils/log';
import { scriptTerminalRun } from '../../../../src/core/workspaces/script-line';
import { useStoreTask } from '@/contexts/TasksContext';
import { ranAtText, scriptRunStatus } from './script-run-text';
import { busyRun, newRunId, noteScriptQueued, scriptResultText, settledBusyRun, useScriptResults, waitForScriptEnd } from './script-results';
import { expectScriptEcho } from './script-echo';
import { noteSetupStartedToast, unwatchSetupRun, watchSetupRun } from './cleanup-notices';
import { workspaceOf } from './workspace-text';
import { ProjectScriptsDialog, scriptRoles } from './ProjectScriptsDialog';
import { ScriptOutputDialog } from './ScriptOutputDialog';
import { StopFirstDialog, type StopFirstAnswer } from './StopFirstDialog';
import '@/styles/workspaces.css';

function PlayIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden focusable="false">
      <path d="M2.5 1.5v7l6-3.5z" fill="currentColor" />
    </svg>
  );
}

/** When each session's Scripts menu was last opened on this page (a failed run newer than it marks the chip). */
const menuSeenAt = new Map<string, number>();
const PAGE_LOADED_AT = Date.now();

/** How long a stopped script may take to print its end line before the next one is typed. */
const STOP_WAIT_MS = 5_000;

export function SessionScriptsChip({ sessionId, taskId, hidden, rowRef, onRun, onInterrupt, openRef }: {
  sessionId: string;
  taskId?: string;
  /** data-hidden of the row fit (the chip is in the "..." menu). */
  hidden: string;
  rowRef: RefObject<HTMLElement | null>;
  /** Open the terminal and type this line into it. */
  onRun: (line: string, script: ResolvedProjectScript, runId: string) => void;
  /** Press Ctrl-C in the terminal (stop what runs there); the answer takes it back while not yet sent. */
  onInterrupt?: () => () => void;
  /** Lets another control open the menu (the phone's top-bar kebab, where the header is not drawn). */
  openRef?: MutableRefObject<((at?: ContextMenuPoint) => void) | null>;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [point, setPoint] = useState<ContextMenuPoint | null>(null);
  const [view, setView] = useState<ScriptsAnswer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ project: string; cwd?: string; host?: string } | null>(null);
  const [showOutput, setShowOutput] = useState(false);
  const alert = useAlert();
  const [stopAsk, setStopAsk] = useState<{ running: string; runId: string; next: string; resolve: (a: StopFirstAnswer) => void } | null>(null);
  const seq = useRef(0);
  // The workspace's setup or cleanup, live from the task row: the chip shows it is
  // running, failed or waiting for an OK, so a session never hides how it went.
  // A cleanup not simply done (the task completed) comes before the setup.
  const storeTask = useStoreTask(taskId);
  const ws = workspaceOf(storeTask);
  const completed = (storeTask as { phase?: string } | undefined)?.phase === 'COMPLETE';
  const live = !!ws && (ws.state === 'ready' || ws.state === 'kept' || ws.state === 'removing');
  // A running cleanup, or how it ended once the completion's cleanup decided (kept or gone).
  const td = ws?.teardown;
  const cleanup = td && ((td.state === 'running' && live) || (td.state !== 'running' && (ws.state === 'removed' || ws.state === 'kept'))) ? td : undefined;
  const setup = cleanup ?? (live && ws.state !== 'removing' ? ws.setup : undefined);
  const role = cleanup ? 'Cleanup' : 'Setup';
  const setupTone = !setup || setup.state === 'done' ? null : setup.state === 'running' ? 'busy' : setup.state === 'failed' ? 'error' : 'warn';

  const load = useCallback(() => {
    const n = ++seq.current;
    setLoadError(null);
    fetchScripts({ session: sessionId }).then((v) => {
      if (n === seq.current) setView(v);
    }, (err) => {
      if (n === seq.current) setLoadError(err instanceof Error ? err.message : String(err));
    });
  }, [sessionId]);

  const open = useCallback((at?: ContextMenuPoint) => {
    if (at) { setPoint(at); load(); markSeenRef.current(); return; }
    if (point) { setPoint(null); return; }
    // The chip, or the row's "..." button when the chip is folded into it.
    const own = btnRef.current?.getBoundingClientRect();
    const anchor = own && own.width > 0 ? own : rowRef.current?.querySelector<HTMLElement>('[data-header-more]')?.getBoundingClientRect();
    setPoint(anchor ? { x: anchor.left, y: anchor.bottom + 4 } : { x: 80, y: 80 });
    load();
    markSeenRef.current();
  }, [point, rowRef, load]);
  const markSeenRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!openRef) return;
    openRef.current = open;
    return () => { if (openRef.current === open) openRef.current = null; };
  }, [openRef, open]);
  const results = useScriptResults(sessionId);
  // Typed here (or seen starting in the terminal's replay) and not ended: the chip says so.
  const handRun = [...results].find(([, r]) => r.state === 'running' && r.live !== undefined)?.[0];
  // A run that failed since the menu was last opened here marks the chip until it is.
  const [seenAt, setSeenAt] = useState(() => menuSeenAt.get(sessionId) ?? PAGE_LOADED_AT);
  const handFailed = !handRun ? [...results].find(([, r]) => r.state === 'failed' && r.at > seenAt)?.[0] : undefined;
  const markSeen = useCallback(() => { const now = Date.now(); menuSeenAt.set(sessionId, now); setSeenAt(now); }, [sessionId]);
  markSeenRef.current = markSeen;
  const { notify } = useNotifications();

  const startRun = useCallback(async (s: ResolvedProjectScript) => {
    // A line typed while a script still runs in the terminal would wait behind it unseen: stop that one first.
    const busy = await settledBusyRun(sessionId);
    if (busy) {
      const [name, was] = busy;
      const answer = await new Promise<StopFirstAnswer>((resolve) => setStopAsk({ running: name, runId: was.runId, next: s.name, resolve }));
      setStopAsk(null);
      if (answer === 'keep') return;
      // It may have ended by itself meanwhile: nothing to stop then.
      const still = answer === 'stop' && busyRun(sessionId)?.[1].runId === was.runId;
      log.info('workspace', 'project script stopped for another', { sessionId, stopped: name, next: s.name, answer, still });
      const takeBack = still ? onInterrupt?.() : undefined;
      if (still && !(await waitForScriptEnd(sessionId, was.runId, STOP_WAIT_MS))) {
        // Not sent yet (the terminal is still connecting): it must not stop it later either.
        takeBack?.();
        await alert({ title: `${name} did not stop`, message: `It is still running in the terminal, so ${s.name} was not run. Stop it there (Ctrl-C), then run ${s.name} again.` });
        return;
      }
    }
    const runId = newRunId();
    const line = scriptTerminalRun(s.name, s.command, view?.dir, runId);
    log.info('workspace', 'project script run in the terminal', { sessionId, script: s.name, source: s.source });
    noteScriptQueued(sessionId, s.name, runId, Date.now(), s.command);
    expectScriptEcho(sessionId, runId, s.command);
    onRun(line, s, runId);
  }, [view?.dir, sessionId, onRun, onInterrupt, alert]);
  // One run at a time: a click while one waits for its answer or its stop does nothing more.
  const starting = useRef(false);
  const run = useCallback(async (s: ResolvedProjectScript) => {
    setPoint(null);
    if (starting.current) return;
    starting.current = true;
    try { await startRun(s); } finally { starting.current = false; }
  }, [startRun]);

  const rerun = useCallback(async (opts: { allow?: boolean; expectHash?: string } = {}) => {
    if (!taskId) return;
    setPoint(null);
    try {
      watchSetupRun(taskId);
      await rerunTaskSetup(taskId, opts).catch((err) => { unwatchSetupRun(taskId); throw err; });
      // It runs as a job, not in the terminal: say where its progress shows (its end is told too).
      const toastId = `setup-started:${taskId}:${Date.now()}`;
      noteSetupStartedToast(taskId, toastId);
      notify({ id: toastId, kind: 'hint', severity: 'info', title: 'Setup started', body: 'It runs beside the session, not in the terminal. A pop-up like this one says when it ends, and the Scripts menu keeps its output.', persistent: false, dedupKey: toastId });
    } catch (err) {
      await alert({ title: 'Could not run setup', message: err instanceof Error ? err.message : String(err) });
    }
  }, [taskId, alert, notify]);

  const items: ContextMenuItem[] = [];
  if (setup) {
    items.push({
      key: 'setup-state',
      // Its output lives on the task row, not in the terminal: a click shows it.
      ...(setup.output ? { title: 'Show its output', onSelect: () => { setPoint(null); setShowOutput(true); } } : { info: true }),
      label: (
        <span className={`session-scripts-setup tone-${setupTone ?? 'ok'}`} data-testid="session-scripts-setup" data-role={role.toLowerCase()}>
          <span className="session-scripts-setup-line">
            {role} <strong>{setup.name}</strong>: {scriptRunStatus(setup)}
            {ranAtText(setup) && <span className="session-scripts-setup-at"> {ranAtText(setup)}</span>}
          </span>
          {setup.state === 'failed' && setup.output && <code className="session-scripts-setup-tail">{setup.output.trim().split('\n').pop()}</code>}
          {setup.output && <span className="session-scripts-setup-more" data-testid="session-scripts-setup-output">Show output</span>}
        </span>
      ),
    });
    // A setup running in the background: its output is not in the terminal.
    if (role === 'Setup' && setup.state === 'running') {
      items.push({ key: 'setup-note', info: true, label: <span className="session-scripts-note" data-testid="session-scripts-setup-note">It runs in the background, not in the terminal: click it above to see its output. A script you run now runs beside it.</span> });
    }
    // The project's setup changed since this one ran: say what a run again would run.
    const nowSetup = view?.setup ? view.scripts.find((s) => s.id === view.setup) : undefined;
    if (role === 'Setup' && nowSetup && setup.state !== 'running' && (nowSetup.name !== setup.name || nowSetup.command !== setup.command)) {
      items.push({ key: 'setup-changed', info: true, label: <span className="session-scripts-note" data-testid="session-scripts-setup-changed">
        {nowSetup.name === setup.name
          ? <>The command of <strong>{nowSetup.name}</strong> changed since it ran: running setup again runs the new one.</>
          : <>The setup is now <strong>{nowSetup.name}</strong>: running setup again runs it.</>}
      </span> });
    }
    // No divider: the menu draws a rule under its leading info lines (heading-end).
  }
  // The task's workspace was removed (it completed): its scripts have no folder to run in.
  const root = ws?.root;
  const gone = !!ws && (ws.state === 'removed' || ws.state === 'removing') && !!root && !!view?.dir
    && (view.dir === root || view.dir.startsWith(`${root}/`));
  if (gone) {
    items.push({ key: 'gone', info: true, label: <span className="session-scripts-note" data-testid="session-scripts-gone">{ws.state === 'removing' ? 'Its workspace is being removed' : 'Its workspace was removed'} (the task completed), so its scripts have no folder to run in.</span> });
  }
  // Where the list goes: the setup line above is the task row's, there at once.
  if (!view && !loadError) items.push({ key: 'loading', info: true, label: <span className="session-scripts-loading" data-testid="session-scripts-loading">Loading scripts…</span> });
  if (loadError) items.push({ key: 'error', info: true, label: <span className="session-scripts-error">{loadError}</span> });
  if (view) {
    const own = view.scripts.filter((s) => s.source === 'project');
    // A project script of the same name replaces the file's in this menu (the editor says so).
    const ownNames = new Set(own.map((s) => s.name.trim().toLowerCase()));
    const file = view.scripts.filter((s) => s.source !== 'project' && !ownNames.has(s.name.trim().toLowerCase()));
    // A result is this script's only while its command is the one that ran (a project
    // script that replaced the file's of that name never inherits its result).
    const resultOf = (s: ResolvedProjectScript) => {
      const r = results.get(s.name);
      return r && (!r.command || r.command === s.command) ? r : undefined;
    };
    const row = (s: ResolvedProjectScript): ContextMenuItem => ({
      key: `${s.source}:${s.id}`,
      // The note above says why: no second line of it, and no play arrow.
      ...(gone ? { disabled: true } : { icon: <PlayIcon /> }),
      ...(gone ? {} : { title: `${s.command}\nRuns in ${view.dir ?? 'the session folder'} (in the terminal)` }),
      label: (
        <span className="session-scripts-item" data-testid="session-script-item" data-name={s.name}>
          <span className="session-scripts-item-top">
            <span className="session-scripts-item-name">{s.name}</span>
            {resultOf(s) && (
              <span className={`session-scripts-result is-${resultOf(s)!.state}`} data-testid="session-script-result"
                title={resultOf(s)!.state === 'notrun' ? 'The terminal was not ready before the page closed (or within a minute), so it was never typed. Run it again.' : undefined}>
                {scriptResultText(resultOf(s)!)}
              </span>
            )}
            {scriptRoles(s, { setup: !!view.setup && view.setup !== s.id, teardown: !!view.teardown && view.teardown !== s.id })
              .map((r) => <span key={r} className={`project-scripts-role${/replaced/.test(r) ? ' is-replaced' : ''}`}>{r}</span>)}
          </span>
          <code className="session-scripts-item-command">{s.command}</code>
        </span>
      ),
      onSelect: gone ? undefined : () => { void run(s); },
    });
    // The script that runs in the terminal now can be stopped from here (Ctrl-C there).
    const running = busyRun(sessionId)?.[0];
    const withStop = (s: ResolvedProjectScript): ContextMenuItem[] => (running && s.name === running && onInterrupt && !gone
      ? [row(s), { key: `stop:${s.id}`, label: <span className="session-scripts-stop" data-testid="session-script-stop">Stop {s.name}</span>, title: 'Press Ctrl-C in the terminal', onSelect: () => { setPoint(null); onInterrupt(); } }]
      : [row(s)]);
    if (own.length) {
      items.push({ key: 'own-head', section: true, label: view.project ? `Project ${view.project}` : 'Project scripts' });
      items.push(...own.flatMap(withStop));
    }
    if (file.length) {
      items.push({ key: 'file-head', section: true, label: `From ${view.file?.name ?? 'walnut.json'}` });
      items.push(...file.flatMap(withStop));
    }
    if (!own.length && !file.length) {
      items.push({
        key: 'empty', info: true,
        label: <span className="session-scripts-empty" data-testid="session-scripts-empty">No scripts yet. Add one here, or commit a <code>walnut.json</code> to the repository.</span>,
      });
    }
    if (view.file?.error) items.push({ key: 'file-error', info: true, label: <span className="session-scripts-error">{view.file.name}: {view.file.error}</span> });
    items.push({ key: 'div', divider: true });
    if (taskId && view.workspace_root && view.setup && !completed) {
      const ran = !!ws?.setup && ws.setup.state !== 'skipped';
      const needsOk = ws?.setup?.state === 'skipped' && ws.setup.untrusted;
      items.push(needsOk
        ? { key: 'rerun', label: `Allow ${view.file?.name ?? 'walnut.json'} and run setup`, title: 'Allow this version of the file on this repository, then run its setup in the workspace', onSelect: () => { void rerun({ allow: true, expectHash: ws?.setup?.file_hash }); } }
        : { key: 'rerun', label: ran ? 'Run setup again' : 'Run setup', title: ran ? 'Run the workspace setup script again, as when the workspace was made' : 'Run the setup script in this workspace now', onSelect: () => { void rerun(); } });
    }
    if (view.project) {
      const project = view.project;
      // A removed workspace has no walnut.json to read: the folder it was made from has the repository's.
      const fileDir = gone && ws?.anchor ? ws.anchor : view.dir;
      items.push({ key: 'edit', label: 'Edit scripts…', onSelect: () => { setPoint(null); setEditing({ project, ...(fileDir ? { cwd: fileDir } : {}), host: view.host }); } });
    } else {
      items.push({ key: 'no-project', info: true, label: <span className="session-scripts-empty">Scripts you add belong to a project: put this task in one to add them.</span> });
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        className={`session-action-chip${point ? ' session-action-chip-active' : ''}`}
        onClick={() => open()}
        title="Project scripts: run one in this session's terminal"
        data-header-id="scripts"
        data-hidden={hidden}
        data-testid="session-scripts-chip"
        aria-haspopup="menu"
        aria-expanded={!!point}
      >
        Scripts
        {setupTone ? (
          <span className={`session-scripts-dot tone-${setupTone}`} data-testid="session-scripts-dot" data-tone={setupTone}
            title={setup ? `${role} ${setup.name}: ${scriptRunStatus(setup)}` : undefined} aria-label={setup ? `${role}: ${scriptRunStatus(setup)}` : undefined} />
        ) : handRun ? (
          // A script run from this menu, still going in the terminal.
          <span className="session-scripts-dot tone-busy" data-testid="session-scripts-dot" data-tone="busy" data-run={handRun}
            title={`${handRun} is running in the terminal`} aria-label={`${handRun} is running in the terminal`} />
        ) : handFailed && (
          <span className="session-scripts-dot tone-error" data-testid="session-scripts-dot" data-tone="error" data-run={handFailed}
            title={`${handFailed} failed: the Scripts menu has its exit code`} aria-label={`${handFailed} failed`} />
        )}
      </button>
      {point && (
        <ContextMenu
          // Measured again once the list has loaded: the first measure saw one "Loading" row.
          key={view || loadError ? 'loaded' : 'loading'}
          point={point}
          items={items}
          onClose={() => setPoint(null)}
          ariaLabel="Project scripts"
          testId="session-scripts-menu"
          className="session-scripts-menu"
          returnFocus={btnRef.current}
        />
      )}
      {stopAsk && (
        <StopFirstDialog sessionId={sessionId} running={stopAsk.running} runId={stopAsk.runId} next={stopAsk.next} onAnswer={stopAsk.resolve} />
      )}
      {showOutput && setup && (
        <ScriptOutputDialog role={role === 'Cleanup' ? 'teardown' : 'setup'} run={setup} onClose={() => setShowOutput(false)} />
      )}
      {editing && (
        <ProjectScriptsDialog
          project={editing.project}
          cwd={editing.cwd}
          host={editing.host}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
