/**
 * Settings > Remote Hosts: the machines that joined with a link (api/hosts-net.ts, server:
 * core/net/net-mac.ts) and the join link being used now. A link is one-use (on the cloud
 * companion, or on this Mac when none is paired); the machine that runs it becomes a host
 * row that says how this Mac reaches it now: direct, through a relay, or not at all.
 *
 * Their host rows are written by the host network (the server keeps them through an editor
 * save), and Remove is the only way out, because it also takes the machine off the
 * companion's list. The same read answers which rows found in ~/.ssh/config are one of these
 * machines (`twins`): the Hosts list shows such a machine once, as the machine.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchNet, fetchNetInvite, makeNetInvite, removeNetMachine, type NetInvite, type NetOverview } from '@/api/hosts-net';
import { ApiError } from '@/api/client';
import { log } from '@/utils/log';
import { useHostLinkChange } from '@/hooks/useHostLinkChange';

const REFRESH_MS = 30_000;
const INVITE_POLL_MS = 3_000;

function errorText(err: unknown): string {
  return (err instanceof ApiError || err instanceof Error ? err.message : String(err)).replace(/[.\s]*$/, '');
}

export interface HostNetwork {
  net: NetOverview | null;
  loadError: string | null;
  load: () => Promise<void>;
  invite: NetInvite | null;
  inviteError: string | null;
  making: boolean;
  /** Make a new link in place of the one shown; resolves once it is shown (or why not). */
  add: () => Promise<void>;
  /** Put the link (or why it could not be made) away. */
  dismiss: () => void;
  /** Remove a machine; resolves true once it is gone from the list. */
  remove: (host: string) => Promise<boolean>;
  removeError: Record<string, string>;
}

/** `refreshKey`: read again when it changes (the hosts in config.yaml). */
export function useHostNetwork(refreshKey: unknown): HostNetwork {
  const [net, setNet] = useState<NetOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [invite, setInvite] = useState<NetInvite | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [removeError, setRemoveError] = useState<Record<string, string>>({});
  const mounted = useRef(true);
  // Set on every mount: StrictMode mounts twice, and the first cleanup would leave it false.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetchNet();
      if (!mounted.current) return;
      setNet(r);
      setLoadError(null);
    } catch (err) {
      if (!mounted.current) return;
      setLoadError(errorText(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') void load(); };
    const timer = window.setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [load]);

  // A machine that connects or drops: read how this Mac reaches it now, not at the next refresh.
  useHostLinkChange(load, net?.machines.map((m) => m.host) ?? []);

  // While a link waits: watch it (its countdown ticks in HostJoinLink, not the whole section).
  const waitingId = invite?.state === 'waiting' ? invite.id : null;
  useEffect(() => {
    if (!waitingId) return;
    const poll = window.setInterval(() => {
      fetchNetInvite(waitingId).then((next) => {
        if (!mounted.current) return;
        setInvite((cur) => (cur?.id === next.id ? next : cur));
        if (next.state === 'joined') void load();
      }, (err) => {
        if (err instanceof ApiError && err.status === 404) setInvite((cur) => (cur?.id === waitingId ? { ...cur, state: 'expired' } : cur));
      });
    }, INVITE_POLL_MS);
    return () => { window.clearInterval(poll); };
  }, [waitingId, load]);

  // A new link takes the old one's place at once: "Making a link..." while it is made, then the
  // link or why not (2026-11-04 review: a failed second link showed under the first, still
  // waiting, and the page landed on the old one).
  const add = useCallback(async () => {
    setMaking(true);
    setInviteError(null);
    setInvite(null);
    try {
      const inv = await makeNetInvite();
      if (!mounted.current) return;
      setInvite(inv);
      void load();
    } catch (err) {
      const msg = errorText(err);
      log.warn('host-network', 'invite failed', { error: msg });
      if (mounted.current) setInviteError(msg);
    } finally {
      if (mounted.current) setMaking(false);
    }
  }, [load]);

  const remove = useCallback(async (host: string) => {
    setRemoveError((e) => { const n = { ...e }; delete n[host]; return n; });
    try {
      await removeNetMachine(host);
      await load();
      return true;
    } catch (err) {
      const msg = errorText(err);
      log.warn('host-network', 'remove failed', { host, error: msg });
      if (mounted.current) setRemoveError((e) => ({ ...e, [host]: msg }));
      return false;
    }
  }, [load]);

  const dismiss = useCallback(() => { setInvite(null); setInviteError(null); }, []);

  return { net, loadError, load, invite, inviteError, making, add, dismiss, remove, removeError };
}
