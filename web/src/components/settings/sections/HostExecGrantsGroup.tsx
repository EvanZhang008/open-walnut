/**
 * "Tasks using other hosts" in Remote Hosts: every task that uses another host (its
 * commands, MCP servers and web services: src/core/hosts/host-exec.ts), with what it ran,
 * and a Revoke for each. A task on a host the user registered gets its grant by itself
 * (no letter); a revoked one stays revoked and asks by letter. Each host has a switch, the
 * hard stop: off, no task from another host starts anything there.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { allowExecGrant, fetchExecGrants, revokeExecGrant, setExecHostClosed, type ExecDenied, type ExecGrant } from '@/api/host-exec';
import { getAllHostStatus, subscribeHostStatus } from '@/hooks/useHostStatus';
import { hostDisplayLabel } from '@/utils/host-display-label';
import { log } from '@/utils/log';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { ToggleSwitch } from '../inputs/ToggleSwitch';

const REFRESH_MS = 30_000;

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** The row's second line: where, since when, and what it ran. */
export function grantSummary(g: ExecGrant, hostLabel: string): string {
  const parts = [`On ${hostLabel}, ${g.via === 'own-host' ? 'allowed (your own host)' : 'allowed'} ${when(g.grantedAt)}`];
  parts.push(g.runs ? `${g.runs} use${g.runs === 1 ? '' : 's'}, last ${when(g.lastRunAt ?? g.grantedAt)}: ${g.lastCommand ?? ''}` : 'not used yet');
  return parts.join(' · ');
}

export function HostExecGrantsGroup({ hostLabels }: { hostLabels: Record<string, string> }) {
  const [grants, setGrants] = useState<ExecGrant[] | null>(null);
  const [denied, setDenied] = useState<ExecDenied[]>([]);
  const [closed, setClosed] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Switch writes in order: only the newest answer is shown, and a read that began before a
  // write (or while one is in flight) never puts an older stop back on screen.
  const switchSeq = useRef(0);
  const switchesInFlight = useRef(0);
  const liveHosts = useSyncExternalStore(subscribeHostStatus, getAllHostStatus, getAllHostStatus);

  const load = useCallback(async () => {
    const seq = switchSeq.current;
    try {
      const r = await fetchExecGrants();
      setGrants(r.grants);
      setDenied(r.denied ?? []);
      if (seq === switchSeq.current && switchesInFlight.current === 0) setClosed(r.closedHosts ?? []);
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

  const toggleHost = async (host: string, open: boolean) => {
    const seq = ++switchSeq.current;
    switchesInFlight.current += 1;
    setError(null);
    setClosed((prev) => (open ? prev.filter((h) => h !== host) : [...new Set([...prev, host])]));
    try {
      const r = await setExecHostClosed(host, !open);
      if (seq === switchSeq.current) setClosed(r.closedHosts);
      log.info('settings', 'host exec host switch', { host, open });
    } catch (err) {
      setError(`Could not change ${host}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      switchesInFlight.current -= 1;
      // The last write settled: read the server's word once, whatever order the answers came in.
      if (switchesInFlight.current === 0) void load();
    }
  };

  if (grants === null) return null;
  const label = (host: string) => (host === '__local__' ? 'this Mac' : hostDisplayLabel(host, liveHosts.find((h) => h.host === host)?.label, hostLabels[host]));
  // Every host the user has: Settings' own rows, plus the ones the status push knows (the
  // cloud companion is not a Settings row), plus any a grant or a stop names.
  const switchHosts = [...new Set(['__local__', ...Object.keys(hostLabels), ...liveHosts.map((h) => h.host), ...closed])];
  return (
    <SettingsGroup
      heading="Tasks using other hosts"
      data-testid="host-exec-grants"
      footer="A task on one of your hosts uses your other hosts without asking you: runs a command, calls an MCP server or reaches a web service there, each use counted here. Revoke stops that task (it asks by letter from then on); a switch off closes that host to every task on another host. A command there can read anything your account can."
    >
      {error && <p className="hf-error" role="status">{error}</p>}
      {switchHosts.map((host) => {
        const open = !closed.includes(host);
        return (
          <SettingsRow
            key={`host-${host}`}
            data-exec-host={host}
            label={`Tasks on other hosts may use ${label(host)}`}
            help={open ? 'On: they start commands, MCP servers and web requests there.' : 'Off: nothing new starts there from another host.'}
            control={
              <ToggleSwitch
                checked={open}
                aria-label={`Tasks on other hosts may use ${label(host)}`}
                onChange={(v) => void toggleHost(host, v)}
              />
            }
          />
        );
      })}
      {grants.length === 0 && denied.length === 0 && (
        <SettingsRow label="No task has used another host yet" help="Each one shows here with what it ran, and a Revoke." />
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
