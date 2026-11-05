/**
 * Settings > Remote Hosts: the machines that joined with a link (api/hosts-net.ts, server:
 * core/net/net-mac.ts) and the join link being used now. A link is one-use (on the cloud
 * companion, or on this Mac when none is paired); the machine that runs it becomes a host
 * row that says how this Mac reaches it now: direct, through a relay, or not at all.
 *
 * Their host rows are written by the host network (the server keeps them through an editor
 * save), and Remove is the only way out, because it also takes the machine off the
 * list your cloud companion keeps. The same read answers which rows found in ~/.ssh/config are
 * one of these machines (`twins`): the Hosts list shows such a machine once, as the machine.
 *
 * A link the person closes while it still waits is kept, out of sight: the list says it still
 * works, with Cancel link, and Join with a link shows it again instead of making a second one
 * (2026-11-04 review: Done left the old link working unseen, and the next press made INV-2). It
 * outlives the pane too (join-link-store.ts): opened again, the pane reads it back from the server.
 * A link that could not be made keeps its code, so the card offers the fix that code names
 * (join-link-model.ts).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelNetInvite, fetchNet, fetchNetInvite, makeNetInvite, removeNetMachine, startNet, type NetInvite, type NetOverview } from '@/api/hosts-net';
import type { JoinFailure } from './join-link-model';
import { keepJoinLink, keptJoinLink } from './join-link-store';
import { ApiError } from '@/api/client';
import { log } from '@/utils/log';
import { useHostLinkChange } from '@/hooks/useHostLinkChange';

const REFRESH_MS = 30_000;
const INVITE_POLL_MS = 3_000;

function errorText(err: unknown): string {
  return (err instanceof ApiError || err instanceof Error ? err.message : String(err)).replace(/[.\s]*$/, '');
}

function failureOf(err: unknown): JoinFailure {
  const body = err instanceof ApiError ? err.body as { code?: unknown } | undefined : undefined;
  return { text: errorText(err), code: typeof body?.code === 'string' ? body.code : null };
}

/** A link a machine can still run. */
export function liveInvite(inv: NetInvite | null, now = Date.now()): inv is NetInvite {
  return !!inv && inv.state === 'waiting' && now <= inv.expiresAt;
}

export interface HostNetwork {
  net: NetOverview | null;
  loadError: string | null;
  load: () => Promise<void>;
  invite: NetInvite | null;
  /** The link's card is open (a closed one that still waits is kept for "still works"). */
  shown: boolean;
  inviteError: JoinFailure | null;
  making: boolean;
  /** Turning the host network on runs now (the fix a failure offers). */
  starting: boolean;
  /**
   * Join with a link: shows the link still waiting, if one is (`reopened`), else makes a new
   * one in place of the one shown; resolves once it is shown (or why not).
   */
  add: () => Promise<{ reopened: boolean }>;
  /** Make a new link even while one waits (the card's New link). */
  renew: () => Promise<void>;
  /** Put the card away: a link that still waits keeps working, out of sight. */
  dismiss: () => void;
  /** Start the host network, then make the link. */
  start: () => Promise<void>;
  /** Call the waiting link back. */
  cancel: () => Promise<void>;
  cancelling: boolean;
  cancelError: string | null;
  /** Remove a machine; resolves true once it is gone from the list. */
  remove: (host: string) => Promise<boolean>;
  removeError: Record<string, string>;
}

/** `refreshKey`: read again when it changes (the hosts in config.yaml). */
export function useHostNetwork(refreshKey: unknown): HostNetwork {
  const [net, setNet] = useState<NetOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [invite, setInvite] = useState<NetInvite | null>(null);
  const [shown, setShown] = useState(false);
  const [inviteError, setInviteError] = useState<JoinFailure | null>(null);
  const [making, setMaking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const inviteRef = useRef(invite);
  inviteRef.current = invite;
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

  // The link that still waited when the pane closed: read back, so it is still there to show again
  // or call back. Until that read answers, nothing is put away (a link made meanwhile wins).
  const [restoring, setRestoring] = useState(() => keptJoinLink() !== null);
  useEffect(() => {
    const kept = keptJoinLink();
    if (!kept) { setRestoring(false); return; }
    fetchNetInvite(kept.id).then((inv) => {
      if (!mounted.current) return;
      if (inv.state === 'waiting' || inv.state === 'joined') {
        setInvite((cur) => cur ?? inv);
        if (inv.state === 'joined') { setShown(true); void load(); }
      }
    }, (err) => {
      log.info('host-network', 'kept link not read back', { invite: kept.id, error: errorText(err) });
    }).finally(() => { if (mounted.current) setRestoring(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!restoring) keepJoinLink(liveInvite(invite) ? invite : null);
  }, [invite, restoring]);

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
        // A machine that came while the card was closed: the card says so again.
        if (next.state === 'joined') { setShown(true); void load(); }
      }, (err) => {
        if (err instanceof ApiError && err.status === 404) setInvite((cur) => (cur?.id === waitingId ? { ...cur, state: 'expired' } : cur));
      });
    }, INVITE_POLL_MS);
    return () => { window.clearInterval(poll); };
  }, [waitingId, load]);

  // A new link takes the old one's place at once: "Making a link..." while it is made, then the
  // link or why not (2026-11-04 review: a failed second link showed under the first, still
  // waiting, and the page landed on the old one).
  const renew = useCallback(async () => {
    setMaking(true);
    setShown(true);
    setInviteError(null);
    setCancelError(null);
    setInvite(null);
    try {
      const inv = await makeNetInvite();
      if (!mounted.current) return;
      setInvite(inv);
      void load();
    } catch (err) {
      const f = failureOf(err);
      log.warn('host-network', 'invite failed', { error: f.text, code: f.code });
      if (mounted.current) setInviteError(f);
    } finally {
      if (mounted.current) setMaking(false);
    }
  }, [load]);

  const add = useCallback(async () => {
    setCancelError(null);
    if (liveInvite(inviteRef.current)) { setShown(true); setInviteError(null); return { reopened: true }; }
    await renew();
    return { reopened: false };
  }, [renew]);

  const start = useCallback(async () => {
    setStarting(true);
    try {
      await startNet();
      log.info('host-network', 'started from a failed link');
    } catch (err) {
      const f = failureOf(err);
      log.warn('host-network', 'start failed', { error: f.text, code: f.code });
      if (mounted.current) { setInviteError(f); setStarting(false); }
      return;
    }
    if (!mounted.current) return;
    setStarting(false);
    void load();
    await renew();
  }, [load, renew]);

  const cancel = useCallback(async () => {
    const inv = inviteRef.current;
    if (!inv) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const next = await cancelNetInvite(inv.id);
      log.info('host-network', 'link called back', { invite: inv.id, state: next.state });
      if (!mounted.current) return;
      setInvite((cur) => (cur?.id === next.id ? next : cur));
      if (next.state === 'joined') { setShown(true); void load(); }
    } catch (err) {
      const msg = errorText(err);
      log.warn('host-network', 'link call back failed', { invite: inv.id, error: msg });
      if (mounted.current) setCancelError(msg);
    } finally {
      if (mounted.current) setCancelling(false);
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

  const dismiss = useCallback(() => {
    setShown(false);
    setInviteError(null);
    setCancelError(null);
    // A link that still waits keeps working: it stays, out of sight. Any other is put away.
    setInvite((cur) => (liveInvite(cur) ? cur : null));
  }, []);

  return {
    net, loadError, load, invite, shown, inviteError, making, starting, add, renew, dismiss, start, cancel, cancelling, cancelError, remove, removeError,
  };
}
