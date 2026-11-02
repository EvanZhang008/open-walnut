/**
 * Settings > Remote Hosts > Machines that joined with a link (api/hosts-net.ts,
 * server: core/net/net-mac.ts). Add a machine makes a one-use invite (on the cloud
 * companion, or on this Mac when none is paired); the new machine runs the link, and the
 * row it becomes says how this Mac reaches it now: direct, through a relay, or not at all.
 * The relay choice sits under it (HostNetworkRelay.tsx).
 *
 * The machines are not rows of the SSH editor above: their host rows are written by
 * the host network (the server keeps them through an editor save), and Remove is the
 * only way out, because it also takes the machine off the companion's list.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchNet, fetchNetInvite, makeNetInvite, removeNetMachine, type NetInvite, type NetMachine, type NetOverview, type NetRelay } from '@/api/hosts-net';
import { ApiError } from '@/api/client';
import { log } from '@/utils/log';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { HostNetworkRelay } from './HostNetworkRelay';
import { CopyButton } from '../inputs/CopyButton';
import { InlineConfirmButton } from '../inputs/InlineConfirmButton';
import { RemoteHostDetail, RemoteHostStatus } from './RemoteHostStatus';
import { hostRowId } from '@/utils/host-settings-nav';
import { useHostDisplayLabels } from '@/hooks/useHostDisplayLabel';

const REFRESH_MS = 30_000;
const INVITE_POLL_MS = 3_000;

function errorText(err: unknown): string {
  return (err instanceof ApiError || err instanceof Error ? err.message : String(err)).replace(/[.\s]*$/, '');
}

/** `linux-x64` -> `Linux x86_64`. */
export function platformLabel(p?: string): string {
  if (!p) return '';
  const [os, arch] = p.split('-');
  const osName = os === 'darwin' ? 'macOS' : os === 'linux' ? 'Linux' : os;
  const archName = arch === 'x64' ? 'x86_64' : arch ?? '';
  return `${osName} ${archName}`.trim();
}

export function pathLabel(m: Pick<NetMachine, 'path' | 'rttMs'>, relay: NetRelay = 'own'): string {
  const rtt = typeof m.rttMs === 'number' ? ` · ${Math.round(m.rttMs)} ms` : '';
  if (m.path === 'direct') return `Direct${rtt}`;
  if (m.path === 'relay') return `${relay === 'public' ? 'Through a public relay' : 'Through your relay'}${rtt}`;
  // No link right now: the status line under the name says why.
  return '';
}

function left(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function HostNetworkGroup() {
  const [net, setNet] = useState<NetOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [invite, setInvite] = useState<NetInvite | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [removeError, setRemoveError] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());
  const hostName = useHostDisplayLabels();
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

  useEffect(() => {
    void load();
    const tick = () => { if (document.visibilityState === 'visible') void load(); };
    const timer = window.setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [load]);

  // While an invite waits: watch it, and count down.
  const waitingId = invite?.state === 'waiting' ? invite.id : null;
  useEffect(() => {
    if (!waitingId) return;
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(() => {
      fetchNetInvite(waitingId).then((next) => {
        if (!mounted.current) return;
        setInvite((cur) => (cur?.id === next.id ? next : cur));
        if (next.state === 'joined') void load();
      }, (err) => {
        if (err instanceof ApiError && err.status === 404) setInvite((cur) => (cur?.id === waitingId ? { ...cur, state: 'expired' } : cur));
      });
    }, INVITE_POLL_MS);
    return () => { window.clearInterval(clock); window.clearInterval(poll); };
  }, [waitingId, load]);

  const add = async () => {
    setMaking(true);
    setInviteError(null);
    try {
      const inv = await makeNetInvite();
      if (!mounted.current) return;
      setInvite(inv);
      setNow(Date.now());
      void load();
    } catch (err) {
      const msg = errorText(err);
      log.warn('host-network', 'invite failed', { error: msg });
      if (mounted.current) setInviteError(msg);
    } finally {
      if (mounted.current) setMaking(false);
    }
  };

  const remove = async (host: string) => {
    setRemoveError((e) => { const n = { ...e }; delete n[host]; return n; });
    try {
      await removeNetMachine(host);
      await load();
    } catch (err) {
      const msg = errorText(err);
      log.warn('host-network', 'remove failed', { host, error: msg });
      if (mounted.current) setRemoveError((e) => ({ ...e, [host]: msg }));
    }
  };

  const machines = net?.machines ?? [];
  const relay = net?.relay ?? 'own';
  const footer = relay === 'none'
    ? 'These machines need no SSH. They reach this Mac directly. Only Walnut can use this connection.'
    : relay === 'public'
      ? 'These machines need no SSH. They reach this Mac directly, or through a public relay that cannot read the traffic. Only Walnut can use this connection.'
      : 'These machines need no SSH. They reach this Mac directly, or through the relay on your cloud companion. Only Walnut can use this connection.';
  const expired = invite?.state === 'waiting' && now > invite.expiresAt;
  const addButton = (
    <SettingsButton onClick={() => void add()} disabled={making} data-testid="host-network-add">
      {invite && (invite.state !== 'waiting' || expired) ? 'New link' : 'Add a machine'}
    </SettingsButton>
  );

  return (
    <>
    <SettingsGroup
      heading="Machines that joined with a link"
      headingTrailing={addButton}
      data-testid="host-network-group"
      footer={footer}
    >
      {invite && (
        <SettingsRow
          className="settings-row-stacked"
          data-testid="host-network-invite"
          data-invite-state={expired ? 'expired' : invite.state}
          wide
          label={invite.state === 'joined'
            ? `${invite.member?.name ?? 'The machine'} joined.`
            : expired || invite.state === 'expired'
              ? 'This link expired.'
              : 'Run this in a terminal on the new machine (macOS or Linux):'}
          help={invite.state === 'waiting' && !expired
            ? <>
                {`Works once, for 10 minutes (${left(invite.expiresAt - now)} left).  Waiting for the machine...`}
                {net?.companion === false && <><br />Keep this Mac awake and online until the machine joins.</>}
              </>
            : undefined}
          control={invite.state === 'waiting' && !expired ? (
            <span className="settings-addons-inline">
              <code className="settings-addons-mono settings-addons-ellipsis" data-testid="host-network-command" title={invite.command}>{invite.command}</code>
              <CopyButton text={invite.command} data-testid="host-network-copy" />
            </span>
          ) : undefined}
        />
      )}
      {inviteError && <SettingsRow state="error" data-testid="host-network-invite-error" label="Could not make a link" error={inviteError} />}
      {loadError && !net && <SettingsRow state="warning" label="Could not read the machines" help={loadError} />}
      {net?.error && <SettingsRow state="warning" data-testid="host-network-sync-error" label="The host network" help={net.error} />}
      {net && machines.length === 0 && !invite && (
        <SettingsRow label="No machines yet." help="Add a machine makes a link you run on it." />
      )}
      {machines.map((m) => {
        const sub = [platformLabel(m.platform), pathLabel(m, relay)].filter(Boolean).join(' · ');
        return (
          <SettingsRow
            key={m.host}
            id={hostRowId(m.host)}
            className="rh-host-row"
            data-host-alias={m.host}
            data-net-path={m.path}
            label={
              <span className="settings-addons-inline">
                <span className="rh-host-name">{hostName(m.host)}</span>
                {sub && <span className="settings-addons-muted settings-addons-ellipsis" data-testid="host-network-path">{sub}</span>}
              </span>
            }
            help={<RemoteHostStatus alias={m.host} name={hostName(m.host)} enabled={m.enabled} />}
            error={removeError[m.host]}
            children={<RemoteHostDetail alias={m.host} name={hostName(m.host)} enabled={m.enabled} />}
            control={<InlineConfirmButton aria-label={`Remove ${hostName(m.host)}`} onConfirm={() => remove(m.host)} />}
          />
        );
      })}
    </SettingsGroup>
    {net && <HostNetworkRelay net={net} onChanged={() => void load()} />}
    </>
  );
}
