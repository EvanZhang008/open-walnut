/**
 * A host problem's voice, mounted ONCE (AppShell), never inside a panel:
 *   - a toast when a problem first appears (host-problem-toasts.ts says which):
 *     its words, Retry for a host Walnut can try again, and Show details, which
 *     opens the notification panel, where the problem is a row (NotificationProblems)
 *     until it heals or the user dismisses it there;
 *   - a screen reader line for what the toast does not say: a host that healed,
 *     the 'same result' receipts, and a new problem while quiet mode holds toasts.
 * It reads the model's inputs and the host action store directly, so no page
 * layout changes what it says (2026-11-16, the user: "please unified, shodl as
 * notificaiton in the notificaiton bar").
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { hostDotOf, hostProblemOf, hostReadySentence } from '@open-walnut/host-problem';
import { serverNow, useAllHostStatus, useHostStatusHydration } from '@/hooks/useHostStatus';
import { useIsReplicaServer } from '@/hooks/useServerRole';
import { nextBanner, type BannerRow } from '@/utils/attention-banner-model';
import { getHostDismissed, subscribeHostDismissed } from '@/utils/host-banner-dismiss';
import { runHostAction, subscribeHostActionEvents } from '@/utils/host-action-store';
import { usePromptedHosts, useUserEngagedHosts } from '@/utils/host-user-retrying';
import { decideHostToasts, hostToastText, problemKeyOf, readToasted, sameToasted, writeToasted } from '@/utils/host-problem-toasts';
import { OPEN_CENTER_EVENT } from '@/utils/open-anywhere';
import { useNotifications } from '@/contexts/notifications';
import { quietAllowsToast } from '@/contexts/notifications/quiet-model';
import { log } from '@/utils/log';
import { readySentenceText } from './HostProblemRows';
import '@/styles/attention-banner.css';

/** Receipts worth saying out loud (a new failure is already its toast). */
export const ANNOUNCED_RECEIPTS: readonly string[] = ['Tried again just now: same result', 'Checked just now: same result'];

/** The toast's buttons: Retry only where every host in it can be tried again by hand. */
function toastActions(rows: readonly BannerRow[]) {
  const retryable = rows.every((r) => r.actions.includes('retry'));
  const retry = () => {
    for (const h of rows.flatMap((r) => r.hosts)) {
      runHostAction(h, 'retry').catch((err) => log.warn('hosts', 'retry from toast failed', { host: h, error: String(err) }));
    }
  };
  const details = () => window.dispatchEvent(new CustomEvent(OPEN_CENTER_EVENT));
  return [
    ...(retryable ? [{ label: rows.length > 1 ? 'Retry all' : 'Retry', kind: 'callback' as const, run: retry }] : []),
    { label: 'Show details', kind: 'callback' as const, run: details },
  ];
}

export function HostProblemNotices() {
  const statuses = useAllHostStatus();
  const hydration = useHostStatusHydration();
  const dismissed = useSyncExternalStore(subscribeHostDismissed, getHostDismissed);
  const replica = useIsReplicaServer();
  const engaged = useUserEngagedHosts();
  const prompted = usePromptedHosts();
  const { notify, quiet } = useNotifications();
  const [message, setMessage] = useState('');
  const known = useRef<ReturnType<typeof readToasted> | null>(null);
  const live = useRef({ notify, quiet });
  live.current = { notify, quiet };
  const hydrated = hydration === 'done' || hydration === 'unsupported' || hydration === 'failed';

  useEffect(() => {
    if (!hydrated) return;
    const at = serverNow();
    const { state } = nextBanner({ statuses, dismissed, now: at, replica, engaged, prompted });
    const problems = state.order.filter((r) => r.type !== 'ready' && r.type !== 'trying');
    const find = (h: string) => statuses.find((x) => x.host === h && !x.removed);
    const healthy = (h: string) => {
      const s = find(h);
      return !!s?.connected && hostDotOf(s, { now: at }).kind === 'connected' && !hostProblemOf(s, { surface: 'banner' });
    };
    // No status yet (a failed or unsupported load): nothing to judge, and judging would
    // forget every known problem and toast them all again when the frames come.
    if (statuses.length === 0) return;
    const before = known.current ?? readToasted();
    const d = decideHostToasts(problems, before, (h) => !!find(h), healthy);
    const lines: string[] = [];
    let next = d.known;
    if (d.toast.length) {
      const { notify: push, quiet: q } = live.current;
      if (quietAllowsToast(q, 'host')) {
        push({
          kind: 'host', severity: d.toast.some((r) => r.group === 'connect') ? 'error' : 'warning',
          ...hostToastText(d.toast),
          dedupKey: `host-problem:${d.toast.map(problemKeyOf).join(',')}`,
          persistent: false,
          actions: toastActions(d.toast),
        });
      } else {
        // Held by quiet: said to a screen reader now, and left unknown so the first frame
        // after quiet ends still toasts it.
        const held = new Map(next);
        for (const r of d.toast) held.delete(problemKeyOf(r));
        next = held;
        lines.push(...d.toast.map((r) => `${r.labels.join(', ')}: ${r.headline ?? r.problem?.message ?? ''}`));
      }
    }
    known.current = next;
    if (!sameToasted(before, next)) writeToasted(next);
    lines.push(...d.healed.map((h) => readySentenceText(hostReadySentence(find(h)?.label || h, find(h)?.readiness?.claude?.version))));
    if (lines.length) setMessage(lines.join('. '));
  }, [hydrated, statuses, dismissed, replica, engaged, prompted]);

  useEffect(() => subscribeHostActionEvents((e) => {
    if (e.kind === 'receipt' && ANNOUNCED_RECEIPTS.includes(e.text)) setMessage(e.text);
  }), []);

  return (
    <div className="hb-announcer" data-testid="host-banner-announcer" role="status" aria-live="polite">{message}</div>
  );
}
