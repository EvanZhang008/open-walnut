/**
 * "Commands from other hosts" in Remote Hosts: every task the user let run
 * commands on another host (host_exec, src/core/hosts/host-exec.ts), with what
 * it ran, and a Revoke for each. A grant comes from the user's Allow on the
 * letter the task's first command sent; it lasts until revoked here.
 */
import { useCallback, useEffect, useState } from 'react';
import { allowExecGrant, fetchExecGrants, revokeExecGrant, type ExecDenied, type ExecGrant } from '@/api/host-exec';
import { log } from '@/utils/log';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';

const REFRESH_MS = 30_000;

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** The row's second line: where, since when, and what it ran. */
export function grantSummary(g: ExecGrant, hostLabel: string): string {
  const parts = [`On ${hostLabel}, allowed ${when(g.grantedAt)}`];
  parts.push(g.runs ? `${g.runs} command${g.runs === 1 ? '' : 's'}, last ${when(g.lastRunAt ?? g.grantedAt)}: ${g.lastCommand ?? ''}` : 'no command run yet');
  return parts.join(' · ');
}

export function HostExecGrantsGroup({ hostLabels }: { hostLabels: Record<string, string> }) {
  const [grants, setGrants] = useState<ExecGrant[] | null>(null);
  const [denied, setDenied] = useState<ExecDenied[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetchExecGrants();
      setGrants(r.grants);
      setDenied(r.denied ?? []);
    } catch (err) {
      log.warn('settings', 'host exec grants read failed', { error: String(err) });
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const revoke = async (g: ExecGrant) => {
    setBusy(g.id);
    setError(null);
    try {
      await revokeExecGrant(g.id);
      setGrants((prev) => (prev ? prev.filter((x) => x.id !== g.id) : prev));
      log.info('settings', 'host exec grant revoked', { grantId: g.id, taskId: g.taskId, host: g.host });
    } catch (err) {
      setError(`Could not revoke: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const allow = async (d: ExecDenied) => {
    const key = `${d.taskId}:${d.host}`;
    setBusy(key);
    setError(null);
    try {
      await allowExecGrant(d.taskId, d.host);
      log.info('settings', 'host exec grant allowed after a deny', { taskId: d.taskId, host: d.host });
      await load();
    } catch (err) {
      setError(`Could not allow: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  if (grants === null) return null;
  const label = (host: string) => (host === '__local__' ? 'this Mac' : hostLabels[host] || host);
  return (
    <SettingsGroup
      heading="Commands from other hosts"
      data-testid="host-exec-grants"
      footer="A task on one host asks you by letter before its first command on another. Allow lasts until you revoke it here; a command there can read anything your account can."
    >
      {error && <p className="hf-error" role="status">{error}</p>}
      {grants.length === 0 && denied.length === 0 && (
        <SettingsRow label="No task may run commands on another host" help="The first time one asks, a letter in your inbox lets you allow it." />
      )}
      {grants.map((g) => (
        <SettingsRow
          key={g.id}
          data-grant-id={g.id}
          label={g.taskTitle || g.taskId}
          help={grantSummary(g, label(g.host))}
          control={
            <SettingsButton variant="text" disabled={busy === g.id} aria-label={`Revoke ${g.taskTitle || g.taskId} on ${label(g.host)}`} onClick={() => void revoke(g)}>
              {busy === g.id ? 'Revoking…' : 'Revoke'}
            </SettingsButton>
          }
        />
      ))}
      {denied.map((d) => {
        const key = `${d.taskId}:${d.host}`;
        return (
          <SettingsRow
            key={`denied-${key}`}
            data-denied={key}
            label={d.taskTitle || d.taskId}
            help={`On ${label(d.host)}, you declined ${when(d.answeredAt ?? d.askedAt)}`}
            control={
              <SettingsButton variant="text" disabled={busy === key} aria-label={`Allow ${d.taskTitle || d.taskId} on ${label(d.host)}`} onClick={() => void allow(d)}>
                {busy === key ? 'Allowing…' : 'Allow'}
              </SettingsButton>
            }
          />
        );
      })}
    </SettingsGroup>
  );
}
