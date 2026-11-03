/**
 * What an Org node's chat shows while it has no session yet (2026-11-03, the user: the VPs should
 * "start from the behind instead of people have to click start and jump to another window").
 *
 * Main and every VP start by themselves in the background (src/core/org/org-autostart.ts). This
 * view says so while it happens, and asks the server once to start a node it shows with none (an
 * older one, or one made while the org was off). Only a start that failed has a button: Retry, in
 * place (and Start, for a Main not made yet or a node Walnut will not start by itself). Nothing
 * here navigates. With the org off (Settings → Org) it says what that stops and
 * offers to turn it back on.
 */
import { useEffect, useRef, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { startOrgNode } from '@/api/org';
import { log } from '@/utils/log';
import { useOrgSettings } from './useOrgSettings';
import type { ChannelRow } from './org-channels-model';
import { orgStartView } from './org-start-view';

export function OrgNodeStart({ row, contact, title, onStart, loading = false, starting = false }: {
  row: ChannelRow; contact: Task | undefined; title: string;
  /** The page's tasks are still loading: nothing is offered until the node is known. */
  loading?: boolean;
  /** The user's first message to Main went out a moment ago (ask-main.ts recentMainStart). */
  starting?: boolean;
  /** Retry, Start, Make a VP: the page starts it in place (OrgPage startChat). */
  onStart: (row: ChannelRow) => void;
}) {
  const { settings, save, loaded } = useOrgSettings();
  const enabled = settings.enabled !== false;
  const [answer, setAnswer] = useState<{ skipped?: string; error?: string; status?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const asked = useRef<string | null>(null);
  const failed = contact?.org_start?.state === 'failed';

  // Shown with no session: ask the server once to start it (it skips one that is starting or failed).
  // A Main not made yet is made by the user's first message or Start; it then starts by itself.
  // Turned off and on again (here or in Settings), the node is asked again.
  useEffect(() => {
    if (enabled) return;
    asked.current = null;
    setAnswer(null);
  }, [enabled]);
  useEffect(() => {
    // Until the switch is read it reads on: asking then would only be refused.
    if (!loaded || !enabled || failed || !contact || asked.current === contact.id) return;
    asked.current = contact.id;
    // Asked even while it reads starting: one a restart cut off is started again, a live one is left alone.
    void startOrgNode(contact.id, true)
      .then((a) => { setAnswer(a.skipped ? { skipped: a.skipped } : null); })
      .catch((err) => setAnswer({
        error: err instanceof Error ? err.message : String(err),
        ...(typeof (err as { status?: unknown })?.status === 'number' ? { status: (err as { status: number }).status } : {}),
      }));
  }, [loaded, enabled, failed, contact?.id]);

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setAnswer(null);
    log.info('org-page', what, { node: row.key, taskId: contact?.id });
    try {
      await fn();
    } catch (err) {
      setAnswer({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };
  const start = () => { setAnswer(null); onStart(row); };

  const view = orgStartView({ enabled: enabled || !loaded, row, contact, answer, loading, starting });
  return (
    <div className="org-chat-start" data-testid="org-chat-start" data-state={view.kind}>
      {view.kind === 'off' && <>
        <p>The org is off, so {title} does not start and gets nothing from Walnut.</p>
        <button type="button" className="btn btn-sm btn-primary" data-testid="org-turn-on" disabled={busy}
          onClick={() => { void run('turn org on', () => save({ enabled: true })); }}>Turn the org on</button>
      </>}
      {view.kind === 'loading' && <p data-testid="org-start-loading"><span className="org-start-spinner" aria-hidden="true" />Loading {title}…</p>}
      {view.kind === 'elsewhere' && <p>{title} runs on your primary Walnut (your Mac). Its chat shows here once it has started there.</p>}
      {view.kind === 'starting' && <p data-testid="org-starting"><span className="org-start-spinner" aria-hidden="true" />{title} is starting…</p>}
      {view.kind === 'failed' && <>
        <p data-testid="org-start-failed">{title} could not start: {view.error}</p>
        <button type="button" className="btn btn-sm btn-primary" data-testid="org-start-retry" disabled={busy} onClick={start}>Retry</button>
      </>}
      {view.kind === 'idle' && <>
        <p>{title} has not started yet.</p>
        <button type="button" className="btn btn-sm btn-primary" data-testid="org-start-chat" disabled={busy} onClick={start}>Start {title}</button>
      </>}
      {view.kind === 'no-vp' && <>
        <p>{row.name} has no VP yet.</p>
        <button type="button" className="btn btn-sm btn-primary" data-testid="org-start-chat" disabled={busy} onClick={start}>Make a VP</button>
      </>}
    </div>
  );
}
