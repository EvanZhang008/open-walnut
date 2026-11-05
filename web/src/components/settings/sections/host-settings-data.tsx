/**
 * Settings > Remote Hosts: the per-host settings every host's "This host" part reads (its
 * Details, HostThisPart.tsx), read once for the page: Walnut on each host (GET /api/host-servers),
 * which tasks from other hosts may use it (/api/v1/host-exec), which secrets are copied there
 * (/api/v1/secrets, also More settings' Secrets list), and its session limit (config.yaml's
 * session_limits, which the section's editor saves with the hosts). 2026-11-04 review: one host's settings sat
 * in its row, its menu, its Details and four groups under More settings; now they live with the
 * host. The provider holds the reads and renders its children unchanged, so a poll re-renders only
 * the parts that read it, never the section's auto-saving editor.
 *
 * Polling: Walnut on a host every 3 s while one is being set up and every 30 s once settled (and
 * at once when the hosts in config.yaml change), grants and secrets every 30 s; never while the
 * tab is hidden.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Config } from '@open-walnut/core';
import { apiGet, apiPut } from '@/api/client';
import { allowExecGrant, fetchExecGrants, revokeExecGrant, setExecHostClosed, type ExecDenied, type ExecGrant } from '@/api/host-exec';
import { deleteSecret, fetchSecrets, saveSecret, type FleetSecret, type SecretChange } from '@/api/secrets';
import { log } from '@/utils/log';
import { saveErrorMessage } from '../settings-pane-context';
import { describeExpose } from './cloud/browser-access-status';
import { describeHostServer, hostServersPollMs, type HostCopyChoice, type HostServerEntry, type HostServersResponse } from './host-servers-status';

const SERVERS = '/api/host-servers';
const REFRESH_MS = 30_000;

export interface ExposePatch { enabled?: boolean; provider?: string; options?: Record<string, string> }

export interface HostServers {
  data: HostServersResponse | null;
  /** The host whose write runs now. */
  busy: string | null;
  errors: Record<string, string>;
  optionErrors: Record<string, Record<string, string>>;
  setOptionError: (hostKey: string, key: string, message: string | null) => void;
  /** Runs one change; true when it was saved. `optionKey` names the tunnel option it saves, if any. */
  call: (hostKey: string, run: () => Promise<{ host: HostServerEntry | null }>, optionKey?: string) => Promise<boolean>;
  write: (hostKey: string, body: { enabled?: boolean; expose?: ExposePatch; copies?: Partial<HostCopyChoice> }, optionKey?: string) => Promise<boolean>;
  /** Option fields being typed in, per host: a poll must not overwrite them. */
  drafts: Record<string, Record<string, string>>;
  setDrafts: (update: (prev: Record<string, Record<string, string>>) => Record<string, Record<string, string>>) => void;
}

export interface ExecGrants {
  grants: ExecGrant[] | null;
  denied: ExecDenied[];
  closed: string[];
  /** A grant id or `<task>:<host>` whose write runs now. */
  busy: string | null;
  error: { host: string; text: string } | null;
  revoke: (g: ExecGrant) => Promise<void>;
  allow: (d: ExecDenied) => Promise<void>;
  toggleHost: (host: string, open: boolean) => Promise<void>;
}

export interface Secrets {
  state: { active: boolean; secrets: FleetSecret[] } | null;
  load: () => Promise<void>;
  save: (name: string, change: SecretChange) => Promise<void>;
  remove: (name: string) => Promise<void>;
  /** A secret whose copy to a host is being changed from that host's part: `<secret>:<host>`. */
  busy: string | null;
  setBusy: (key: string | null) => void;
}

export interface SessionLimits {
  /** config.session_limits as typed, keyed by alias ('local' for this Mac). */
  values: Record<string, string | number>;
  set: (update: (prev: Record<string, string | number>) => Record<string, string | number>) => void;
}

export interface HostSettings {
  servers: HostServers;
  exec: ExecGrants;
  secrets: Secrets;
  limits: SessionLimits;
  /** Each host's name as the list shows it (This Mac for `__local__`). */
  label: (host: string) => string;
}

const Ctx = createContext<HostSettings | null>(null);

export function useHostSettings(): HostSettings | null {
  return useContext(Ctx);
}

function useServers(hosts: Config['hosts']): HostServers {
  const [data, setData] = useState<HostServersResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Refused tunnel option saves, per host and option: each shown under its option, whose box keeps
  // the typed value, until that option is saved or put back. No other write clears one.
  const [optionErrors, setOptionErrors] = useState<Record<string, Record<string, string>>>({});
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const readSeq = useRef(0);
  const setOptionError = useCallback((hostKey: string, key: string, message: string | null) =>
    setOptionErrors((prev) => {
      if (message === null && !prev[hostKey]?.[key]) return prev;
      const next = { ...(prev[hostKey] ?? {}) };
      if (message === null) delete next[key];
      else next[key] = message;
      return { ...prev, [hostKey]: next };
    }), []);

  const load = useCallback(async () => {
    const seq = ++readSeq.current;
    try {
      const res = await apiGet<HostServersResponse>(SERVERS, undefined, { timeoutMs: 10_000, quietStatuses: [404] });
      if (seq === readSeq.current) setData(res);
    } catch (err) {
      log.warn('settings', 'host server state read failed', { error: String(err) });
    }
  }, []);
  const hostsKey = JSON.stringify(hosts ?? {});
  useEffect(() => { void load(); }, [load, hostsKey]);
  const interval = hostServersPollMs(data);
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) void load(); }, interval);
    return () => clearInterval(timer);
  }, [interval, load]);

  const call = useCallback(async (hostKey: string, run: () => Promise<{ host: HostServerEntry | null }>, optionKey?: string): Promise<boolean> => {
    setBusy(hostKey);
    setErrors((prev) => { const next = { ...prev }; delete next[hostKey]; return next; });
    readSeq.current++;
    try {
      const res = await run();
      if (res.host) { const h = res.host; setData((prev) => (prev ? { ...prev, hosts: prev.hosts.map((x) => (x.hostKey === h.hostKey ? h : x)) } : prev)); }
      if (optionKey) setOptionError(hostKey, optionKey, null);
      return true;
    } catch (err) {
      log.warn('settings', 'host server setting not saved', { hostKey, optionKey, error: saveErrorMessage(err) });
      if (optionKey) setOptionError(hostKey, optionKey, saveErrorMessage(err));
      else setErrors((prev) => ({ ...prev, [hostKey]: saveErrorMessage(err) }));
      return false;
    } finally {
      setBusy(null);
      void load();
    }
  }, [load, setOptionError]);
  const write = useCallback((hostKey: string, body: { enabled?: boolean; expose?: ExposePatch; copies?: Partial<HostCopyChoice> }, optionKey?: string) =>
    call(hostKey, () => apiPut<{ host: HostServerEntry | null }>(`${SERVERS}/${encodeURIComponent(hostKey)}`, body), optionKey), [call]);
  return { data, busy, errors, optionErrors, setOptionError, call, write, drafts, setDrafts };
}

function useExec(): ExecGrants {
  const [grants, setGrants] = useState<ExecGrant[] | null>(null);
  const [denied, setDenied] = useState<ExecDenied[]>([]);
  const [closed, setClosed] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ExecGrants['error']>(null);
  // Switch writes in order: only the newest answer is shown, and a read that began before a
  // write (or while one is in flight) never puts an older stop back on screen.
  const switchSeq = useRef(0);
  const switchesInFlight = useRef(0);
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
  const revoke = useCallback(async (g: ExecGrant) => {
    setBusy(g.id);
    setError(null);
    try {
      await revokeExecGrant(g.id);
      setGrants((prev) => (prev ? prev.filter((x) => x.id !== g.id) : prev));
      log.info('settings', 'host exec grant revoked', { grantId: g.id, taskId: g.taskId, host: g.host });
    } catch (err) {
      setError({ host: g.host, text: `Could not revoke: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusy(null);
    }
  }, []);
  const allow = useCallback(async (d: ExecDenied) => {
    setBusy(`${d.taskId}:${d.host}`);
    setError(null);
    try {
      await allowExecGrant(d.taskId, d.host);
      log.info('settings', 'host exec grant allowed after a deny', { taskId: d.taskId, host: d.host });
      await load();
    } catch (err) {
      setError({ host: d.host, text: `Could not allow: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusy(null);
    }
  }, [load]);
  const toggleHost = useCallback(async (host: string, open: boolean) => {
    const seq = ++switchSeq.current;
    switchesInFlight.current += 1;
    setError(null);
    setClosed((prev) => (open ? prev.filter((h) => h !== host) : [...new Set([...prev, host])]));
    try {
      const r = await setExecHostClosed(host, !open);
      if (seq === switchSeq.current) setClosed(r.closedHosts);
      log.info('settings', 'host exec host switch', { host, open });
    } catch (err) {
      setError({ host, text: `Could not change it: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      switchesInFlight.current -= 1;
      // The last write settled: read the server's word once, whatever order the answers came in.
      if (switchesInFlight.current === 0) void load();
    }
  }, [load]);
  return { grants, denied, closed, busy, error, revoke, allow, toggleHost };
}

function useSecretsData(): Secrets {
  const [state, setState] = useState<Secrets['state']>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setState(await fetchSecrets());
    } catch (err) {
      log.warn('settings', 'secrets read failed', { error: String(err) });
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  const save = useCallback(async (name: string, change: SecretChange) => {
    await saveSecret(name, change);
    log.info('settings', 'secret saved', { name, hosts: change.hosts, rotated: !!change.value });
    await load();
  }, [load]);
  const remove = useCallback(async (name: string) => {
    const r = await deleteSecret(name);
    log.info('settings', 'secret deleted', { name, pending: r.pending });
    await load();
  }, [load]);
  return { state, load, save, remove, busy, setBusy };
}

export function HostSettingsProvider({ hosts, labels, limits, onLimits, children }: {
  hosts: Config['hosts'];
  labels: Record<string, string>;
  limits: SessionLimits['values'];
  onLimits: SessionLimits['set'];
  children: ReactNode;
}) {
  const servers = useServers(hosts);
  const exec = useExec();
  const secrets = useSecretsData();
  const labelsKey = JSON.stringify(labels);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const label = useCallback((host: string) => (host === '__local__' || host === 'local' ? 'This Mac' : labels[host] || host), [labelsKey]);
  const limitsValue = useMemo(() => ({ values: limits, set: onLimits }), [limits, onLimits]);
  const value = useMemo(() => ({ servers, exec, secrets, limits: limitsValue, label }), [servers, exec, secrets, limitsValue, label]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Why a host's own settings need a look, if they do: Walnut on it stopped or runs an older build,
 * its tunnel failed, or a secret could not be copied there. The row counts it with the rest
 * (HostRow.tsx), so the page has one count.
 */
export function useHostSettingsLook(host: string | undefined): string | null {
  const ctx = useContext(Ctx);
  if (!ctx || !host) return null;
  const entry = ctx.servers.data?.hosts.find((h) => h.hostKey === host);
  if (entry && hostServerLook(entry, !!ctx.servers.errors[host])) return 'Walnut on this host needs a look: see Details.';
  const stuck = (ctx.secrets.state?.secrets ?? []).find((s) => !s.deletedAt && s.hosts.includes(host) && !!s.copies[host]?.error);
  if (stuck) return `The secret ${stuck.name} could not be copied here: see Details.`;
  return null;
}

/** Walnut on a host offers a retry (it stopped, or runs an older build), or its tunnel does. */
export function hostServerLook(entry: HostServerEntry, hasError: boolean): boolean {
  if (!entry.settings.enabled) return false;
  return describeHostServer(entry).retry || (entry.settings.expose.enabled && describeExpose(entry.view?.server?.expose ?? null, '').retry) || hasError;
}
