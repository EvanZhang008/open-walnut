/**
 * The attention card's screen reader voice, mounted ONCE (AppShell), never
 * inside a card: a live region inside the card re-announced everything each
 * time the card remounted in another place. This one says only changes: a
 * new problem ('Net box: <headline>'), a success sentence, and the 'same
 * result' receipts. It reads the model's inputs and the host action store
 * directly, so a mount or owner switch announces nothing.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { hostDotOf, hostProblemOf, hostReadySentence } from '@open-walnut/host-problem';
import { serverNow, useAllHostStatus, useHostStatusHydration } from '@/hooks/useHostStatus';
import { useIsCloudReplica } from '@/hooks/useIsCloudReplica';
import { nextBanner } from '@/utils/attention-banner-model';
import { getHostDismissed, subscribeHostDismissed } from '@/utils/host-banner-dismiss';
import { subscribeHostActionEvents } from '@/utils/host-action-store';
import { useUserEngagedHosts } from '@/utils/host-user-retrying';
import { readySentenceText } from './HostProblemRows';
import '@/styles/attention-banner.css';

/** Receipts worth saying out loud (a new failure is already a new problem sentence). */
export const ANNOUNCED_RECEIPTS: readonly string[] = ['Tried again just now: same result', 'Checked just now: same result'];

export function HostBannerAnnouncer() {
  const statuses = useAllHostStatus();
  const hydration = useHostStatusHydration();
  const dismissed = useSyncExternalStore(subscribeHostDismissed, getHostDismissed);
  const replica = useIsCloudReplica();
  const engaged = useUserEngagedHosts();
  const [message, setMessage] = useState('');
  const seen = useRef<Map<string, string[]> | null>(null);
  const hydrated = hydration === 'done' || hydration === 'unsupported' || hydration === 'failed';

  useEffect(() => {
    if (!hydrated) return;
    const at = serverNow();
    const { state } = nextBanner({ statuses, dismissed, now: at, replica, engaged });
    const problems = state.order.filter((r) => r.type !== 'ready' && r.type !== 'trying');
    const find = (h: string) => statuses.find((x) => x.host === h && !x.removed);
    const healthy = (h: string) => {
      const s = find(h);
      return !!s?.connected && hostDotOf(s, { now: at }).kind === 'connected' && !hostProblemOf(s, { surface: 'banner' });
    };
    const prev = seen.current;
    const next = new Map(problems.map((r) => [r.id, r.hosts]));
    const healed = new Set<string>();
    // A problem stays known until its host heals (an auto retry in flight is not a new problem).
    for (const [id, hosts] of prev ?? []) {
      if (next.has(id)) continue;
      for (const h of hosts) if (find(h) && healthy(h)) healed.add(h);
      const open = hosts.filter((h) => find(h) && !healthy(h));
      if (open.length) next.set(id, open);
    }
    seen.current = next;
    // The first answer is the baseline: a page load says nothing.
    if (!prev) return;
    const lines = [
      ...problems.filter((r) => !prev.has(r.id)).map((r) => `${r.labels.join(', ')}: ${r.headline ?? r.problem?.message ?? ''}`),
      ...[...healed].map((h) => readySentenceText(hostReadySentence(find(h)?.label || h, find(h)?.readiness?.claude?.version))),
    ];
    if (lines.length) setMessage(lines.join('. '));
  }, [hydrated, statuses, dismissed, replica, engaged]);

  useEffect(() => subscribeHostActionEvents((e) => {
    if (e.kind === 'receipt' && ANNOUNCED_RECEIPTS.includes(e.text)) setMessage(e.text);
  }), []);

  return (
    <div className="hb-announcer" data-testid="host-banner-announcer" role="status" aria-live="polite">{message}</div>
  );
}
