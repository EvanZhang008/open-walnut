/**
 * "Reach Walnut from anywhere": a guided Tailscale setup inside Settings,
 * Phones & Cloud (primary console only). Three numbered rows, each with a dot
 * (muted = not yet, amber = your turn, green = done):
 *
 *   1. Tailscale on this Mac   install (the Mac App Store, or Homebrew), open and sign in
 *   2. Tailscale on your phone the App Store QR, until a phone peer is online
 *   3. Pair the phone          already paired, or pick the tailnet address below
 *
 * The state comes from GET /api/devices/tailscale, polled every 5s while step 1
 * or 2 is open and every 60s once both are done, never while the tab is
 * hidden. The steps themselves are derived in remote-access-steps.ts (pure).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { ApiError, apiGet, apiPost } from '@/api/client';
import { log } from '@/utils/log';
import { SettingsGroup, SettingsRow } from '../../SettingsSection';
import { SettingsButton } from '../../inputs/SettingsButton';
import {
  TAILSCALE_APP_STORE_URL,
  TAILSCALE_DOWNLOAD_URL,
  TAILSCALE_MAC_APP_STORE_URL,
  TAILSCALE_PLAY_URL,
  deriveRemoteAccessSteps,
  pollIntervalMs,
  type PairedDeviceLike,
  type StepDot,
  type TailscaleDetailResponse,
  type TailscaleInstallJob,
} from './remote-access-steps';
import '@/styles/settings-sections-addons.css';
import '@/styles/remote-access-card.css';

interface Props {
  /** Paired devices (GET /api/devices `devices` + `cloudDevices`); null while that list loads. */
  devices: readonly PairedDeviceLike[] | null;
  /** The pairing picker offers the tailnet address right now. */
  tailnetOffered: boolean;
  /** Step 3: pick the tailnet address in the picker below. */
  onChooseTailnet: () => void;
  /** This Mac joined or left the tailnet: the picker's addresses changed. */
  onTailnetChange: () => void;
}

const STATUS_PATH = '/api/devices/tailscale';
const DOT_WORD: Record<StepDot, string> = { pending: 'Not yet', action: 'Your turn', done: 'Done' };

/** One QR for the App Store link per page; it never changes. */
let storeQr: Promise<string> | null = null;
function appStoreQr(): Promise<string> {
  // Same settings as the pairing QR (usePairDevice): phones scan glossy screens at an angle.
  storeQr ??= QRCode.toDataURL(TAILSCALE_APP_STORE_URL, { errorCorrectionLevel: 'M', width: 240, margin: 2 });
  return storeQr;
}

const shortUrl = (url: string) => url.replace(/^https:\/\//, '');

function StepTitle({ n, dot, title }: { n: number; dot: StepDot; title: string }) {
  return (
    <span className="remote-access-step-title">
      <span className="remote-access-dot" data-dot={dot} aria-hidden="true" />
      <span>{n}. {title}</span>
      <span className="settings-visually-hidden">{`, ${DOT_WORD[dot]}`}</span>
    </span>
  );
}

export function RemoteAccessCard({ devices, tailnetOffered, onChooseTailnet, onTailnetChange }: Props) {
  const [status, setStatus] = useState<TailscaleDetailResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [installBusy, setInstallBusy] = useState(false);
  const [openBusy, setOpenBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  // Only the newest read writes: a poll that left before an Install click must not wipe its job.
  const readSeq = useRef(0);
  // A tick never stacks a second read on a slow server; failures are logged once per streak.
  const reading = useRef(0);
  const failStreak = useRef(0);
  const load = useCallback(async (refresh: boolean, { fromPoll = false } = {}) => {
    if (fromPoll && reading.current > 0) return;
    const seq = ++readSeq.current;
    reading.current += 1;
    try {
      const res = await apiGet<TailscaleDetailResponse>(
        STATUS_PATH,
        refresh ? { refresh: '1' } : undefined,
        { quietStatuses: [404], timeoutMs: 10_000 },
      );
      failStreak.current = 0;
      if (seq !== readSeq.current) return;
      setStatus(res);
      setFailed(false);
    } catch (err) {
      // A cloud companion has no such route: the card is not for it.
      if (err instanceof ApiError && err.status === 404) {
        setUnavailable(true);
        return;
      }
      if (++failStreak.current === 1) log.warn('settings', 'tailscale status read failed', { error: String(err) });
      if (seq === readSeq.current) setFailed(true);
    } finally {
      reading.current -= 1;
    }
  }, []);

  const steps = useMemo(
    () => deriveRemoteAccessSteps(status, devices, { failed, tailnetOffered }),
    [status, devices, failed, tailnetOffered],
  );
  const interval = pollIntervalMs(steps);

  // The first read takes the server's cached answer (GET /api/devices just warmed it).
  useEffect(() => { void load(false); }, [load]);

  useEffect(() => {
    if (unavailable) return undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = setInterval(() => { void load(true, { fromPoll: true }); }, interval);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (timer !== undefined) clearInterval(timer);
        timer = undefined;
        return;
      }
      void load(true);
      start();
    };
    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (timer !== undefined) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [interval, load, unavailable]);

  // This Mac joining (or leaving) the tailnet changes the picker's addresses.
  const tailnetKey = status ? `${status.running}|${status.address ?? ''}` : null;
  const lastTailnetKey = useRef<string | null>(null);
  useEffect(() => {
    if (tailnetKey === null) return;
    const prev = lastTailnetKey.current;
    lastTailnetKey.current = tailnetKey;
    if (prev !== null && prev !== tailnetKey) onTailnetChange();
  }, [tailnetKey, onTailnetChange]);

  const showStores = steps.phone.showStores;
  useEffect(() => {
    if (!showStores || qr) return;
    let live = true;
    appStoreQr()
      .then((url) => { if (live) setQr(url); })
      .catch((err: unknown) => log.warn('settings', 'app store qr failed', { error: String(err) }));
    return () => { live = false; };
  }, [showStores, qr]);

  // A refusal or a failed Open belongs to the state it was made in.
  const macKind = steps.mac.kind;
  useEffect(() => { setActionError(null); }, [macKind]);

  const install = async () => {
    if (installBusy) return;
    setInstallBusy(true);
    setActionError(null);
    try {
      const res = await apiPost<{ job: TailscaleInstallJob }>(`${STATUS_PATH}/install`, {}, { quietStatuses: [400, 409] });
      readSeq.current += 1;
      setStatus((prev) => (prev ? { ...prev, install: { ...prev.install, job: res.job } } : prev));
      log.info('settings', 'tailscale install started', { startedAt: res.job.startedAt });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      log.warn('settings', 'tailscale install refused', { error: String(err) });
      void load(true);
    } finally {
      setInstallBusy(false);
    }
  };

  const openApp = async () => {
    if (openBusy) return;
    setOpenBusy(true);
    setActionError(null);
    try {
      await apiPost<{ opened: boolean }>(`${STATUS_PATH}/open`, {}, { quietStatuses: [500, 501] });
      log.info('settings', 'tailscale app opened');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      log.warn('settings', 'tailscale open failed', { error: String(err) });
    } finally {
      setOpenBusy(false);
    }
  };

  if (unavailable) return null;
  const { mac, phone, pair } = steps;
  // Walnut's primary is normally a Mac; a Linux box gets the same card with a download link and a terminal.
  const machine = mac.macOS ? 'this Mac' : 'this computer';

  const macHelp = (() => {
    switch (mac.kind) {
      case 'checking': return `Checking Tailscale on ${machine}...`;
      case 'unknown': return `Couldn't check Tailscale on ${machine}; trying again.`;
      case 'not-installed': return mac.macOS ? 'Get Tailscale from the App Store, then come back here.' : `Install Tailscale on ${machine}.`;
      // The cask is a .pkg: Homebrew's sudo shows the Touch ID sheet where sudo is set up for it.
      case 'installing': return 'Installing with Homebrew... If macOS asks for Touch ID, approve it.';
      case 'not-running': return mac.macOS
        ? 'Open Tailscale and sign in with Apple, Google, or another account. This page updates by itself.'
        : 'Run tailscale up in a terminal and sign in with Apple, Google, or another account. This page updates by itself.';
      case 'running': return mac.connectedAs ? `Connected as ${mac.connectedAs}` : 'Connected';
    }
  })();

  // The primary install is the one that needs no password: the Mac App Store on a Mac, Tailscale's download page elsewhere.
  const macControl = mac.kind === 'not-installed' ? (
    <span className="settings-addons-inline">
      {mac.canBrew && (
        <SettingsButton busy={installBusy} busyLabel="Starting..." onClick={() => void install()} data-testid="remote-access-install">
          Install with Homebrew
        </SettingsButton>
      )}
      <a
        className="settings-button settings-button-primary"
        href={mac.macOS ? TAILSCALE_MAC_APP_STORE_URL : TAILSCALE_DOWNLOAD_URL}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="remote-access-download"
      >
        {mac.macOS ? 'Get from the App Store' : 'Download'}
      </a>
    </span>
  ) : mac.kind === 'not-running' ? (
    <span className="settings-addons-inline">
      {mac.loginUrl && (
        <a className="settings-button settings-button-default" href={mac.loginUrl} target="_blank" rel="noopener noreferrer" data-testid="remote-access-sign-in">
          Sign in
        </a>
      )}
      {mac.macOS && (
        <SettingsButton variant="primary" busy={openBusy} busyLabel="Opening..." onClick={() => void openApp()} data-testid="remote-access-open">
          Open Tailscale
        </SettingsButton>
      )}
    </span>
  ) : undefined;

  const phoneHelp = phone.dot === 'done'
    ? `Your phone is on the tailnet (${phone.onlinePhone})`
    : 'Install Tailscale on the phone and sign in with the same account.';

  const pairHelp = pair.paired
    ? 'Already paired: open Walnut on the phone once and it learns the Tailscale route by itself.'
    : 'Pair the phone below with the Tailscale address.';

  return (
    <SettingsGroup heading="Reach Walnut from anywhere" className="remote-access-card" data-testid="remote-access-card">
      <SettingsRow
        className="remote-access-step"
        data-step="mac"
        data-dot={mac.dot}
        data-kind={mac.kind}
        label={<StepTitle n={1} dot={mac.dot} title={`Tailscale on ${machine}`} />}
        help={macHelp}
        error={actionError ?? mac.installError}
        control={macControl}
      >
        {mac.kind === 'installing' && mac.logTail.length > 0 && (
          <pre className="remote-access-log settings-addons-mono" data-testid="remote-access-log">
            {mac.logTail.join('\n')}
          </pre>
        )}
      </SettingsRow>

      <SettingsRow
        className="remote-access-step"
        data-step="phone"
        data-dot={phone.dot}
        label={<StepTitle n={2} dot={phone.dot} title="Tailscale on your phone" />}
        help={phoneHelp}
      >
        {phone.offlinePhone && (
          <span className="settings-row-help remote-access-note">
            {phone.offlinePhone} is signed in but offline; open Tailscale on it and switch it on.
          </span>
        )}
        {showStores && (
          <span className="remote-access-stores" data-testid="remote-access-stores">
            {qr && (
              <img
                className="remote-access-qr"
                src={qr}
                alt="QR code for Tailscale on the App Store"
                width={112}
                height={112}
                data-testid="remote-access-app-store-qr"
              />
            )}
            <span className="settings-row-help">
              iPhone:{' '}
              <a className="settings-addons-link" href={TAILSCALE_APP_STORE_URL} target="_blank" rel="noopener noreferrer">
                {shortUrl(TAILSCALE_APP_STORE_URL)}
              </a>
            </span>
            <span className="settings-row-help">
              Android:{' '}
              <a className="settings-addons-link" href={TAILSCALE_PLAY_URL} target="_blank" rel="noopener noreferrer">
                {shortUrl(TAILSCALE_PLAY_URL)}
              </a>
            </span>
          </span>
        )}
      </SettingsRow>

      <SettingsRow
        className={`remote-access-step${pair.canChooseTailnet ? ' remote-access-step--choice' : ''}`}
        data-step="pair"
        data-dot={pair.dot}
        label={<StepTitle n={3} dot={pair.dot} title="Pair the phone" />}
        help={pairHelp}
        // The whole row picks the address; the button is its keyboard and screen-reader handle.
        onClick={pair.canChooseTailnet ? onChooseTailnet : undefined}
        control={pair.canChooseTailnet ? (
          <SettingsButton variant="text" data-testid="remote-access-use-tailnet">Use the Tailscale address</SettingsButton>
        ) : undefined}
      />
    </SettingsGroup>
  );
}
