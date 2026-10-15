/**
 * "Copies that held off" (docs/plan/walnut-replica-servers-impl.md, section 4):
 * a copy of this Mac's data on another server (a host's Walnut, the cloud
 * companion) refused three rounds in a row a copy that would remove most of its
 * rows, in case this Mac lost them. One row per refusal says how many rows would
 * go; "Remove them there" (two clicks) confirms it for exactly the rows the user
 * read, and the row then says the next copy takes it. A row, never a letter;
 * nothing at all while every copy works.
 *
 * State comes from GET /api/replicas/status every 30 s (every 5 s while a
 * confirm waits for its round), never while the tab is hidden. The confirm is
 * POST /api/replicas/confirm-removal with the refusal's count and keys.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '@/api/client';
import { log } from '@/utils/log';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { InlineConfirmButton } from '../inputs/InlineConfirmButton';
import { saveErrorMessage } from '../settings-pane-context';
import { replicaRemovalRows, type ReplicaRemovalRow, type ReplicasStatusResponse, type ReplicaTargetKind } from './replica-removal-status';

const PATH = '/api/replicas/status';

export function ReplicaRemovalGroup({ only, labels }: { only?: ReplicaTargetKind; labels?: Record<string, string> }) {
  const [data, setData] = useState<ReplicasStatusResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** This server keeps no follower's copies (a follower's own console answers 404): stop asking. */
  const [noCopies, setNoCopies] = useState(false);
  const readSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++readSeq.current;
    try {
      // A follower (the companion's own console) answers 404 leader_only: nothing to show.
      const res = await apiGet<ReplicasStatusResponse>(PATH, undefined, { timeoutMs: 10_000, quietStatuses: [404] });
      if (seq === readSeq.current) setData(res);
    } catch (err) {
      if ((err as { status?: unknown } | null)?.status === 404) { setNoCopies(true); return; }
      log.warn('settings', 'replica status read failed', { error: String(err) });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const rows = replicaRemovalRows(data, only);
  const interval = rows.some((r) => r.state === 'armed') ? 5_000 : 30_000;
  useEffect(() => {
    if (noCopies) return;
    const timer = setInterval(() => { if (!document.hidden) void load(); }, interval);
    return () => clearInterval(timer);
  }, [interval, load, noCopies]);

  const confirm = async (row: ReplicaRemovalRow) => {
    if (!row.confirm) return;
    setBusy(row.id);
    setErrors((prev) => { const next = { ...prev }; delete next[row.id]; return next; });
    readSeq.current++;
    try {
      await apiPost('/api/replicas/confirm-removal', row.confirm, { quietStatuses: [409] });
      log.info('settings', 'replica removal confirmed', { target: row.target, kind: row.kind, entries: row.confirm.entries });
    } catch (err) {
      const message = saveErrorMessage(err);
      log.warn('settings', 'replica removal not confirmed', { target: row.target, kind: row.kind, error: message });
      setErrors((prev) => ({
        ...prev,
        [row.id]: /not_refused|409/.test(message)
          ? 'The rows changed since you read this; Walnut checks again on the next copy.'
          : message,
      }));
    } finally {
      setBusy(null);
      void load();
    }
  };

  if (rows.length === 0) return null;
  return (
    <SettingsGroup heading="Copies that held off" data-testid={`replica-removals${only ? `-${only}` : ''}`}>
      {rows.map((row) => (
        <SettingsRow
          key={row.id}
          data-testid={`replica-removal-${row.id}`}
          data-removal={row.state}
          state={row.state === 'refused' ? 'warning' : undefined}
          label={labels?.[row.target] ?? row.label}
          help={<span data-testid={`replica-removal-text-${row.id}`}>{row.text}</span>}
          error={errors[row.id]}
          control={row.state === 'refused' ? (
            <InlineConfirmButton
              label="Remove them there"
              confirmLabel="Confirm remove"
              disabled={busy === row.id}
              aria-label={`Remove them from the copy on ${labels?.[row.target] ?? row.label}`}
              data-testid={`replica-removal-confirm-${row.id}`}
              onConfirm={() => confirm(row)}
            />
          ) : undefined}
        />
      ))}
    </SettingsGroup>
  );
}
