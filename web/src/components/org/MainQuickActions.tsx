/**
 * Main's quick actions (main-quick-actions.ts): tidy projects, put tasks in place, triage.
 *
 *   row   the Org page's Main: the actions as buttons under its Latest line
 *   menu  the Tasks page's Projects heading: one "Tidy up" button that opens them as a menu
 *
 * A click sends Main the action's message (ask-main.ts); `onSent` then shows Main's chat.
 * Main answers with a list first, so the click itself changes nothing.
 */
import { useEffect, useRef, useState } from 'react';
import { ContextMenu, type ContextMenuItem, type ContextMenuPoint } from '@/components/common/ContextMenu';
import { SparklesIcon } from '@/components/icons/SparklesIcon';
import { useIsCloudReplica } from '@/hooks/useIsCloudReplica';
import { log } from '@/utils/log';
import { askMain, type AskMainResult } from './ask-main';
import {
  MAIN_QUICK_ACTIONS_NOTE, quickActionMessage, quickActionsFor,
  type MainQuickActionId, type MainQuickActionScope,
} from './main-quick-actions';
import '@/styles/main-quick-actions.css';

interface Props {
  variant: 'row' | 'menu';
  scope?: MainQuickActionScope;
  onSent: (result: AskMainResult) => void;
}

export function MainQuickActions({ variant, scope, onSent }: Props) {
  const actions = quickActionsFor(scope);
  const [busy, setBusy] = useState<MainQuickActionId | null>(null);
  const [error, setError] = useState('');
  const [held, setHeld] = useState(false);
  // Main lives with the primary: a replica cannot make or reach it.
  const replica = useIsCloudReplica();
  const [point, setPoint] = useState<ContextMenuPoint | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const run = async (id: MainQuickActionId) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(id);
    setError('');
    setHeld(false);
    try {
      const result = await askMain(quickActionMessage(id, scope));
      log.info('org', result.held ? 'main quick action held: Main waits on the user' : 'main quick action sent', {
        action: id, taskId: result.taskId, sessionId: result.sessionId, started: result.started,
      });
      if (!mounted.current) return;
      // Held: Main's chat opens on the prompt it waits on, and the row says why nothing went.
      setHeld(!!result.held);
      onSent(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('org', 'main quick action failed', { action: id, error: message });
      if (mounted.current) setError(message);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  if (replica) return null;

  if (variant === 'row') {
    return (
      <div className="main-qa" role="group" aria-label="Ask Main to" data-testid="main-quick-actions">
        <span className="main-qa-lead">Ask Main to</span>
        {actions.map((a) => (
          <button
            key={a.id}
            type="button"
            className="main-qa-btn"
            data-testid={`main-qa-${a.id}`}
            title={a.hint}
            disabled={busy !== null}
            aria-busy={busy === a.id}
            onClick={() => { void run(a.id); }}
          >
            <SparklesIcon size={12} />
            {busy === a.id ? 'Sending…' : a.label}
          </button>
        ))}
        {error
          ? <span className="main-qa-error" role="alert" title={error} data-testid="main-qa-error">Not sent. Try again.</span>
          : held
            ? <span className="main-qa-note is-held" role="status" data-testid="main-qa-held">Not sent: Main is waiting on your answer. Answer it in the chat first.</span>
            : <span className="main-qa-note">{MAIN_QUICK_ACTIONS_NOTE}</span>}
      </div>
    );
  }

  const items: ContextMenuItem[] = [
    { key: 'head', section: true, label: 'Ask Main to' },
    ...actions.map((a): ContextMenuItem => ({
      key: a.id,
      ai: true,
      title: a.hint,
      label: (
        <span className="main-qa-item" data-testid={`main-qa-${a.id}`}>
          <span className="main-qa-item-label">{a.label}</span>
          <span className="main-qa-item-hint">{a.hint}</span>
        </span>
      ),
      onSelect: () => { void run(a.id); },
    })),
    { key: 'sep', divider: true },
    { key: 'note', info: true, label: <span className="main-qa-item-hint">{MAIN_QUICK_ACTIONS_NOTE}</span> },
  ];
  const open = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setPoint({ x: r.left, y: r.bottom + 4 });
  };
  return (
    <span className="main-qa-host">
      <button
        ref={triggerRef}
        type="button"
        className="main-qa-trigger"
        data-testid="main-qa-trigger"
        aria-haspopup="menu"
        aria-expanded={point !== null}
        disabled={busy !== null}
        title={scope ? 'Ask Main to tidy this project' : 'Ask Main to tidy your projects and tasks'}
        onClick={() => (point ? setPoint(null) : open())}
      >
        <SparklesIcon size={12} />
        {busy ? 'Asking Main…' : 'Tidy up'}
      </button>
      {error && !busy && (
        <span className="main-qa-error" role="alert" title={error} data-testid="main-qa-error">Not sent. Try again.</span>
      )}
      {point && (
        <ContextMenu
          point={point}
          items={items}
          onClose={() => setPoint(null)}
          ariaLabel="Ask Main to"
          testId="main-qa-menu"
          className="main-qa-menu"
          returnFocus={triggerRef.current}
        />
      )}
    </span>
  );
}
