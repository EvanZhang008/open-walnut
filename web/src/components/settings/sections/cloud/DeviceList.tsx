/**
 * The devices a Phones & Cloud tab lists, their actions, and pairing a new phone
 * (device-scope.ts says which rows each tab holds):
 *
 *   Cloud companion  Pair the Walnut app this way, Phones on this companion, Macs on this companion
 *   Tailscale        Pair the Walnut app this way, Phones paired with this Mac
 *   Tunnel           Signed-in browsers, Walnut extension
 *   Same Wi-Fi       Pair the Walnut app on this Wi-Fi, Sign in a browser on this Wi-Fi
 *                    (WifiSignIn.tsx), Phones paired with this Mac
 *   All devices      Phones with the Walnut app, Signed-in browsers, Walnut extension, Other
 *                    Macs, each row tagged with its ways; it pairs nothing on this Mac (each
 *                    way's tab does), only on the companion's own console
 *   Advanced         (Settings > Advanced) this Mac's own cloud link and simulators, folded
 *
 * A phone shows in every tab whose way it uses, and its Remove says it removes the
 * whole phone: one pairing works on every way, so there is no removing one way.
 * Show QR and Pair open the code in a dialog (PairQrDialog). The token appears
 * exactly once (only its hash is stored server-side).
 */
import { useState, useEffect, useRef } from 'react';
import { SettingsGroup, SettingsRow, SettingsTag, SettingsDisclosure, SettingsNotice } from '../../SettingsSection';
import { EmptyState, LoadingState, UnavailableState } from '../../../common/EmptyState';
import { SettingsButton } from '../../inputs/SettingsButton';
import { InlineConfirmButton, isRepeatClick } from '../../inputs/InlineConfirmButton';
import { useSettingsSaved } from '../../settings-pane-context';
import { formatAbsoluteTime } from '../addons-format';
import { apiDelete } from '@/api/client';
import { ApiError } from '@/api/api-error';
import { BROWSER_SIGNED_IN_EVENT, devicesListChanged } from './devices-list';
import { WifiSignInRow } from './WifiSignIn';
import { useEvent } from '@/hooks/useWebSocket';
import { PairQrDialog, type PairQrPhase } from './PairQrDialog';
import { requestFailureText } from '@/utils/request-failure';
import { browserRowLabels } from '../browser-labels';
import { usePairDevice, type PairTargetKind } from './usePairDevice';
import { useDevicesData, type DeviceEntry } from './useDevicesData';
import { preferredKind } from './pair-targets';
import { useIsReplicaServer } from '@/hooks/useServerRole';
import { CLOUD_CHANGE_CLIENT_TIMEOUT_MS } from './cloud-change-timeout';
import { ownFirst, useDeviceCaller } from './device-caller';
import { OwnDeviceSignOut } from './OwnDeviceSignOut';
import { SIGNED_IN_BROWSER, SignOutAllBrowsers, type SignOutResult } from './SignOutAllBrowsers';
import { describeDevice, describeMacRow, reachWords, ROLE_NOTE, UNPAIR_SELF_WARNING, CLOUD_UNPAIRED_NOTICE, DEVICES_CHANGED_EVENT } from './device-rows-copy';
import { PairPhoneGroup } from './PairPhoneGroup';
import { DEVICES_TAB, WAY_PANES } from '../../settings-way-panes';
import { useTunnelName } from './tunnel-name';
import { mergeDeviceRows, pairTargetForScope, removePhoneWarning, rowsForScope, wayTags, type DeviceRow, type DeviceScope } from './device-scope';
import '@/styles/settings-sections-addons.css';

type RowError = { name: string; verb: 'remove' | 're-pair' | 'unpair'; message: string };

/** The pairing QR dialog: which phone, whether it replaces a paired phone's code, and its step. */
interface QrDialogState {
  name: string;
  repair: boolean;
  target?: PairTargetKind;
  phase: PairQrPhase;
  error: string | null;
}

/** The heading of a tab's phone list, and what it says with none. */
const PHONES_GROUP: Record<DeviceScope, { heading: string; empty: { title: string; hint?: string } }> = {
  all: { heading: 'Phones with the Walnut app', empty: { title: 'No phone has the Walnut app signed in yet', hint: 'Pair one on the tab of the way it will use.' } },
  cloud: { heading: 'Phones on this companion', empty: { title: 'No phone is paired with the companion yet' } },
  tailscale: { heading: 'Phones paired with this Mac', empty: { title: 'No phone is paired with this Mac yet' } },
  wifi: { heading: 'Phones paired with this Mac', empty: { title: 'No phone is paired with this Mac yet' } },
  browser: { heading: '', empty: { title: '' } },
  advanced: { heading: '', empty: { title: '' } },
};

/** What "a phone with the Walnut app" is, once, where All devices lists them (2026-11-18, the user: "what is a paired phone?"). */
const PHONES_ALL_NOTE = 'Signed in once by scanning a QR code; then it works over every way it can reach.';

/** Which way a phone row's new QR points at, in the words of its tab. */

const BROWSERS_NOTE = 'A sign-in works on every address of this Walnut; Sign out ends it everywhere.';

/** On this Mac, where to sign one in: the two ways' tabs, linked (All devices makes no code). */
function BrowsersAllSignIn() {
  const tunnel = useTunnelName();
  return (
    <>
      {'New browser: '}
      <a className="settings-addons-link devices-go-link" href={`#${WAY_PANES.wifi}`} data-testid="devices-all-go-wifi-browser">Same Wi-Fi</a>
      {' or '}
      <a className="settings-addons-link devices-go-link" href={`#${WAY_PANES.browser}`} data-testid="devices-all-go-tunnel">{tunnel?.title ?? 'Tunnel'}</a>
    </>
  );
}

/** On this Mac, where to pair one: each way's own tab, linked (All devices has no QR). */
const PHONES_ALL_PAIR = (
  <>
    {'New phone: '}
    <a className="settings-addons-link devices-go-link" href={`#${WAY_PANES.cloud}`} data-testid="devices-all-go-cloud">Cloud companion</a>
    {', '}
    <a className="settings-addons-link devices-go-link" href={`#${WAY_PANES.wifi}`} data-testid="devices-all-go-wifi">Same Wi-Fi</a>
    {' or '}
    <a className="settings-addons-link devices-go-link" href={`#${WAY_PANES.tailscale}`} data-testid="devices-all-go-tailscale">Tailscale</a>
  </>
);

export function DeviceList({ scope }: { scope: DeviceScope }) {
  const replica = useIsReplicaServer();
  const tunnelName = useTunnelName()?.title ?? 'the tunnel';
  const data = useDevicesData({ replica });
  const { devices, cloudDevices, targets, listState, tailscale, cloudError, cloudUnpaired, cloudWithheld, refresh } = data;
  // A browser signed in with a code: its own row says so, other rows offer no Remove, and it pairs nothing.
  const caller = useDeviceCaller();
  // All devices pairs only where no way tab does (device-scope.ts); it waits for the list to know.
  const fixedTarget = scope === 'all' && listState !== 'ready'
    ? null
    : pairTargetForScope(scope, targets.map((t) => t.kind), { replica, deviceCaller: caller.isDevice });
  // Signing a browser in on this Wi-Fi: its own tab, on this Mac, by the person at it, once the list names its address.
  const wifiSignIn = scope === 'wifi' && !replica && !caller.isDevice && listState === 'ready';
  const wifiOrigin = wifiSignIn ? targets.find((t) => t.kind === 'lan')?.origin ?? null : null;
  const { created, qrDataURL, busy, mint, dismiss } = usePairDevice();
  const [rowError, setRowError] = useState<RowError | null>(null);
  // "Signed out 4 browsers.", after Sign out (the rows it names are gone), until the pane closes.
  const [signedOut, setSignedOut] = useState<SignOutResult | null>(null);
  useEvent(BROWSER_SIGNED_IN_EVENT, () => setSignedOut(null));
  // "Unpair this Mac" and a phone's Remove are two deliberate clicks with the warning between them.
  const [unpairArmed, setUnpairArmed] = useState(false);
  const [removeArmed, setRemoveArmed] = useState<string | null>(null);
  // The question takes the focus on Cancel, so a second Enter never removes the phone.
  useEffect(() => {
    if (!removeArmed) return;
    document.querySelector<HTMLElement>(`.devices-row[data-device-name="${CSS.escape(removeArmed)}"] [data-testid="devices-remove-cancel"]`)?.focus();
  }, [removeArmed]);
  /** Cancel the question, the focus back on the row's Remove. */
  const disarmRemove = () => {
    const name = removeArmed;
    setRemoveArmed(null);
    if (name) requestAnimationFrame(() => document.querySelector<HTMLElement>(`.devices-row[data-device-name="${CSS.escape(name)}"] [data-testid="devices-remove"]`)?.focus());
  };
  const disarmOnEscape = (e: { key: string; stopPropagation: () => void }) => {
    if (e.key === 'Escape') { e.stopPropagation(); disarmRemove(); }
  };
  const [qrDialog, setQrDialog] = useState<QrDialogState | null>(null);
  const qrReturnFocus = useRef<HTMLElement | null>(null);
  const { notifySaved } = useSettingsSaved();

  const openQrDialog = (next: QrDialogState) => {
    qrReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQrDialog(next);
  };
  const closeQrDialog = () => {
    dismiss();
    setQrDialog(null);
    const back = qrReturnFocus.current;
    qrReturnFocus.current = null;
    if (back?.isConnected) requestAnimationFrame(() => back.focus());
  };

  /** Make the code the dialog is for; a failure stays in the dialog with Try again. */
  const runMint = async (dlg: QrDialogState): Promise<boolean> => {
    if (busy) return false;
    setQrDialog({ ...dlg, phase: 'working', error: null });
    let failure: string | null = null;
    const made = await mint({ name: dlg.name, target: dlg.target, replace: dlg.repair || undefined, onError: (m) => { failure = m; } });
    setQrDialog((cur) => (cur && cur.name === dlg.name
      ? { ...cur, phase: made ? 'shown' : 'failed', error: made ? null : failure }
      : cur));
    if (made) {
      await refresh();
      // The tab bar counts the devices from its own read.
      window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT));
    }
    return !!made;
  };

  /**
   * Re-pair an existing phone: a FRESH token for the same name, shown as a QR again
   * (tokens are one-time; an app reinstall wipes the phone's copy). The dialog asks
   * first: the new code signs the phone out until it scans it.
   */
  const repair = (name: string, kind: PairTargetKind) => {
    if (busy) return;
    setRowError(null);
    dismiss();
    openQrDialog({ name, repair: true, target: kind, phase: 'ask', error: null });
  };
  // A way's tab shows a phone's new QR for its own way (2026-11-21, the user: "Put it in closest
  // so people know"); All devices offers none on this Mac (which address would it carry?), only on
  // the companion's own console, where its one address is the only way. Tailscale offers none
  // either: it lists every phone paired with this Mac, and a tailnet-only code would cut off one
  // without Tailscale; a paired phone needs no new code to use it (it reaches the same pairing).
  const repairKind = (d: DeviceRow): PairTargetKind | null => {
    if (scope === 'all') return replica ? preferredKind(d.kinds, targets.map((t) => t.kind)) : null;
    if (scope === 'tailscale') return null;
    const own = pairTargetForScope(scope, targets.map((t) => t.kind), { replica, deviceCaller: caller.isDevice });
    return own && (own === 'lan' || targets.some((t) => t.kind === own)) ? own : null;
  };

  const pair = async (name: string, chosen: PairTargetKind | undefined) => {
    dismiss();
    const dlg: QrDialogState = { name, repair: false, target: chosen, phase: 'working', error: null };
    openQrDialog(dlg);
    return runMint(dlg);
  };

  /**
   * Revoke EVERY credential behind a row. A phone paired to both this Mac and the
   * cloud has two records; one left would still let the device in.
   */
  const revoke = async (name: string, kinds: PairTargetKind[], verb: RowError['verb'] = 'remove') => {
    setRowError(null);
    let waitedMs = 15_000;
    try {
      for (const kind of kinds) {
        waitedMs = kind === 'cloud' ? CLOUD_CHANGE_CLIENT_TIMEOUT_MS : 15_000;
        try {
          await apiDelete(`/api/devices/${encodeURIComponent(name)}${kind === 'cloud' ? '?target=cloud' : ''}`, { timeoutMs: waitedMs });
        } catch (err) {
          // Already gone: removing one record removes its copy on the other box too (by
          // hash, in the background), and another console may have removed it first.
          if (!(err instanceof ApiError && err.status === 404)) throw err;
        }
        devicesListChanged();
      }
      notifySaved();
      await refresh();
      window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT));
    } catch (err) {
      // A refused or failed removal is an answer about this device, not an unsaved
      // settings change: it shows on the row only.
      setRowError({ name, verb, message: requestFailureText(err, waitedMs) });
      // The confirm that had the focus is gone: back on the row's Remove, beside the reason.
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`.devices-row[data-device-name="${CSS.escape(name)}"] [data-testid="devices-remove"]`)?.focus());
      // A record that did go is gone from the list now, not at the next poll.
      void refresh();
      window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT));
    }
  };

  const rows = rowsForScope(mergeDeviceRows(devices, cloudDevices), scope);
  const tailscaleRunning = !!tailscale?.running;
  // Only once the probe answered: a probe not back yet (or failing) keeps the rows, as before.
  const tailscaleIdle = scope === 'tailscale' && tailscale != null && !tailscale.running && listState === 'ready';
  const selfRow = scope === 'advanced' || scope === 'cloud' ? cloudDevices.find((d) => d.role === 'self') : undefined;
  // The phone used most recently leads.
  const byLastUse = (a: { lastUsedAt?: string }, b: { lastUsedAt?: string }) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '');
  const phones = ownFirst(rows.filter((r) => (r.role ?? 'phone') === 'phone').sort(byLastUse), caller.name);
  const browsers = ownFirst(rows.filter((r) => r.role === 'browser').sort(byLastUse), caller.name);
  // "iPhone Safari", "iPhone Safari 2": the kind recorded at sign-in, never the id (N2-21).
  const browserLabels = browserRowLabels(rows.filter((r) => r.role === 'browser'));
  // Signed in with a link, apart from the Walnut extension: the group's rows are exactly the
  // ones its sign-out row signs out.
  const linkBrowsers = browsers.filter((r) => SIGNED_IN_BROWSER.test(r.name));
  const extensions = browsers.filter((r) => !SIGNED_IN_BROWSER.test(r.name));
  const signedInBrowsers = linkBrowsers.map((r) => r.name);
  const macs = rows.filter((r) => r.role === 'mac');
  const others = rows.filter((r) => (r.role ?? 'phone') !== 'phone' && r.role !== 'mac' && r.role !== 'browser');
  const rowErrorFor = (name: string) => (rowError?.name === name ? `Couldn't ${rowError.verb}: ${rowError.message}` : undefined);

  /** This Mac as the companion knows it: no QR, and removal is a deliberate unpair. */
  const renderSelfRow = (d: DeviceEntry) => (
    <SettingsRow
      key="this-mac"
      className="devices-row devices-row-self"
      data-device-name={d.name}
      data-device-role="self"
      label={
        <span className="settings-addons-inline devices-name">
          <span className="settings-addons-ellipsis" title={d.name}>This Mac</span>
          {scope !== 'cloud' && <SettingsTag>Cloud companion</SettingsTag>}
        </span>
      }
      help={<span className="devices-meta">{ROLE_NOTE.self}</span>}
      error={rowErrorFor(d.name)}
      control={unpairArmed ? (
        <>
          <SettingsButton variant="ghost" data-testid="devices-unpair-self-cancel" onClick={() => setUnpairArmed(false)}>
            Cancel
          </SettingsButton>
          <SettingsButton
            variant="danger-confirm"
            data-testid="devices-unpair-self-confirm"
            onClick={(e) => { if (isRepeatClick(e)) return; setUnpairArmed(false); void revoke(d.name, ['cloud'], 'unpair'); }}
          >
            Unpair this Mac
          </SettingsButton>
        </>
      ) : (
        <SettingsButton variant="danger" data-testid="devices-unpair-self" onClick={() => { setRowError(null); setUnpairArmed(true); }}>
          Unpair this Mac
        </SettingsButton>
      )}
    >
      {unpairArmed && <SettingsNotice kind="warn" role="alert">{UNPAIR_SELF_WARNING}</SettingsNotice>}
    </SettingsRow>
  );

  const renderRow = (d: DeviceRow) => {
    const role = d.role ?? 'phone';
    const own = caller.name === d.name;
    const hw = role === 'phone' ? describeDevice(d.info) : null;
    const meta = role === 'phone'
      ? [
          hw ?? 'Model unknown until the app opens on this phone',
          `paired ${formatAbsoluteTime(d.createdAt)}`,
          ...(d.lastUsedAt ? [`last used ${formatAbsoluteTime(d.lastUsedAt)}`] : []),
        ].join(', ')
      : role === 'mac' ? describeMacRow(d)
      // A signed-in browser says when it signed in and was last used, so two rows can be told apart (N18).
      : role === 'browser' ? [
          `signed in ${formatAbsoluteTime(d.createdAt)}`,
          ...(d.lastUsedAt ? [`last used ${formatAbsoluteTime(d.lastUsedAt)}`] : []),
        ].join(', ')
      : ROLE_NOTE[role];
    const shownName = role === 'browser' ? browserLabels.get(d.name) ?? 'Browser' : d.name;
    const armed = role === 'phone' && removeArmed === d.name;
    const tags = wayTags(d, { scope, replica });
    const phoneRemove = armed ? (
      <>
        <SettingsButton variant="ghost" data-testid="devices-remove-cancel" onKeyDown={disarmOnEscape} onClick={disarmRemove}>
          Cancel
        </SettingsButton>
        <SettingsButton
          variant="danger-confirm"
          data-testid="devices-remove-confirm"
          onKeyDown={disarmOnEscape}
          onClick={(e) => { if (isRepeatClick(e)) return; setRemoveArmed(null); void revoke(d.name, d.kinds); }}
        >
          {`Remove ${shownName}`}
        </SettingsButton>
      </>
    ) : (
      <SettingsButton
        variant="danger"
        aria-label={`Remove ${shownName}`}
        data-testid="devices-remove"
        onClick={() => { setRowError(null); setRemoveArmed(d.name); }}
      >
        Remove
      </SettingsButton>
    );
    return (
      <SettingsRow
        key={d.name}
        className="devices-row"
        data-device-name={d.name}
        data-device-role={role}
        label={
          <span className="settings-addons-inline devices-name">
            <span className="settings-addons-ellipsis" title={d.name}>{shownName}</span>
            {own && <span className="badge badge-accent devices-own-tag" data-testid="devices-own-tag"><span>{caller.touch ? 'This phone' : 'This browser'}</span></span>}
            {/* On a way's tab the tags name the OTHER ways it uses ("Also:"); on an idle Tailscale tab every way it uses is another. */}
            {tags.map((t) => <SettingsTag key={t}>{scope === 'all' ? t : `Also: ${t}`}</SettingsTag>)}
            {/* A browser's sign-in is the same on every address: said on its row, not guessed per way. */}
            {SIGNED_IN_BROWSER.test(d.name) && <SettingsTag>All addresses</SettingsTag>}
          </span>
        }
        help={<span className="devices-meta">{meta}</span>}
        error={rowErrorFor(d.name)}
        data-own-device={own ? 'true' : undefined}
        // Tailscale not running here: its phones are listed (each way lists its own), managed on All devices.
        control={own ? <OwnDeviceSignOut name={d.name} touch={caller.touch} /> : caller.isDevice ? undefined : (
          <>
            {role === 'phone' && !armed && repairKind(d) !== null && (
              <SettingsButton
                disabled={busy}
                aria-label={`Show a new pairing QR code for ${shownName}`}
                data-testid="devices-show-qr"
                onClick={() => repair(d.name, repairKind(d)!)}
              >
                Show pairing QR
              </SettingsButton>
            )}
            {role === 'phone' ? phoneRemove : (
              // A browser signed in with a link is signed out, in the words its group uses; a Mac or the extension is removed.
              <InlineConfirmButton
                {...(SIGNED_IN_BROWSER.test(d.name) ? { label: 'Sign out', confirmLabel: 'Confirm sign out' } : {})}
                aria-label={`${SIGNED_IN_BROWSER.test(d.name) ? 'Sign out' : 'Remove'} ${shownName}`}
                data-testid="devices-remove"
                onConfirm={() => revoke(d.name, d.kinds)}
              />
            )}
          </>
        )}
      >
        {armed && <SettingsNotice kind="warn" role="alert">{removePhoneWarning(d, { replica }, shownName)}</SettingsNotice>}
      </SettingsRow>
    );
  };

  const phonesWords = PHONES_GROUP[scope];
  // Idle Tailscale lists none: its step 3 already says a paired phone uses it by itself once it runs.
  const phonesGroup = scope !== 'browser' && scope !== 'advanced' && !tailscaleIdle
    // A phone signed in only by browser (All devices): its group is Signed-in browsers, no empty box here.
    && (scope !== 'all' || phones.length > 0 || listState !== 'ready' || browsers.length === 0 || cloudUnpaired || cloudError) && (
    <SettingsGroup
      // Paired is not the same as using this way: say which, while Tailscale does not run here.
      heading={phonesWords.heading}
      headingTrailing={phones.length > 0 ? String(phones.length) : undefined}
      // All devices: where a new phone pairs (on this Mac) on the heading line, found before the rows.
      headingAction={scope === 'all' && !replica ? PHONES_ALL_PAIR : undefined}
      description={scope === 'all' ? PHONES_ALL_NOTE : undefined}
      footer={scope === 'tailscale' && (tailscaleRunning || listState !== 'ready') ? 'Tailscale reaches the pairing a phone has with this Mac: a phone here uses this way once the Tailscale app runs on it too, signed in to the same tailnet.' : undefined}
      data-testid={scope === 'all' ? 'devices-phones-group' : `way-devices-${scope}`}
    >
      {phones.length === 0 && (scope !== 'all' || listState !== 'ready' || browsers.length === 0)
        // The cloud tab's error notice below already says the companion's list could not be read.
        && !(scope === 'cloud' && cloudError && listState === 'ready') && (
        listState === 'loading' ? <LoadingState title="Loading paired phones…" testId="devices-phones-empty" />
          : listState === 'failed' ? <UnavailableState title="Couldn't load paired phones" onRetry={() => { void refresh(); }} testId="devices-phones-empty" />
            // The cloud's half is unknown: say only what is known.
            // A caller away from this Mac is not shown the companion's phones (it says so, not "none").
            : scope === 'cloud' && cloudWithheld ? <EmptyState title="The companion's phones are listed only on this Mac itself" testId="devices-phones-empty" />
            : scope !== 'tailscale' && scope !== 'wifi' && (cloudError || cloudUnpaired)
              ? (scope === 'cloud'
                ? <UnavailableState title="Couldn't read the companion's phones" testId="devices-phones-empty" />
                : <EmptyState title="No phones paired with this Mac" testId="devices-phones-empty" />)
              : scope === 'all' && fixedTarget !== null ? <EmptyState title="No phone has the Walnut app signed in yet" hint="Pair one below." testId="devices-phones-empty" />
                : <EmptyState title={phonesWords.empty.title} hint={phonesWords.empty.hint} testId="devices-phones-empty" />
      )}
      {phones.map(renderRow)}
      {scope !== 'tailscale' && scope !== 'wifi' && cloudUnpaired && <SettingsNotice kind="info">{CLOUD_UNPAIRED_NOTICE}</SettingsNotice>}
      {scope !== 'tailscale' && scope !== 'wifi' && cloudError && <SettingsNotice kind="error" role="alert">{cloudError}</SettingsNotice>}
    </SettingsGroup>
  );

  const pairGroup = fixedTarget !== null && (
    <PairPhoneGroup
      scope={scope}
      fixedTarget={fixedTarget}
      targets={targets}
      listState={listState}
      busy={busy}
      onPair={pair}
    />
  );

  const wifiBrowserGroup = wifiSignIn && (
    // A browser on this Wi-Fi, with no tunnel: a one-time code for this Mac's own address.
    <SettingsGroup heading="Web browser: sign in" id="devices-wifi-browser" data-testid="devices-wifi-browser">
      {wifiOrigin
        ? <WifiSignInRow origin={wifiOrigin} />
        : <UnavailableState title="This Mac's address on the network can't be detected right now" hint="Until it is, there is no address to open." />}
    </SettingsGroup>
  );

  const browsersGroup = linkBrowsers.length > 0 && (
        // Browsers signed in with a code (a phone's Safari, another computer): their own group,
        // so a signed-in phone never reads "No phones paired yet".
        <SettingsGroup
          heading="Browsers signed in to this Walnut"
          headingTrailing={String(linkBrowsers.length)}
          // A browser's sign-in is not tied to the address it opened: say so where a way's tab lists them.
          description={BROWSERS_NOTE}
          headingAction={scope === 'all' && !replica ? <BrowsersAllSignIn /> : undefined}
          data-testid="devices-browsers-group"
        >
          {/* First, so it stays in reach above a long list; with one browser, its own row's
              Sign out is the same action. */}
          {!caller.isDevice && signedInBrowsers.length >= 2 && (
            <SignOutAllBrowsers
              names={signedInBrowsers}
              onDone={async (result) => {
                // The list first, then the line: it never says "signed out" beside rows still listed.
                devicesListChanged(); await refresh(); window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT));
                setSignedOut(result.line ? result : null);
              }}
            />
          )}
          {linkBrowsers.map(renderRow)}
        </SettingsGroup>
      );

  return (
    <div className="devices-section" data-testid={`devices-list-${scope}`}>
      {/* On a way's tab, what adds a device comes first, then the devices already there. */}
      {scope !== 'all' && pairGroup}
      {/* Same Wi-Fi: its two ways in side by side (the app, a browser), then who is in. */}
      {wifiBrowserGroup}
      {phonesGroup}
      {scope === 'wifi' && browsersGroup}

      {scope !== 'wifi' && browsersGroup}
      {scope === 'browser' && linkBrowsers.length === 0 && extensions.length === 0 && (
        <SettingsGroup heading="Browsers signed in to this Walnut" data-testid="devices-browsers-group">
          {listState === 'loading' ? <LoadingState title="Loading signed-in browsers…" />
            : listState === 'failed' ? <UnavailableState title="Couldn't load signed-in browsers" onRetry={() => { void refresh(); }} />
              : <EmptyState title="No browser is signed in with a link yet" />}
        </SettingsGroup>
      )}
      {/* Said where the browsers were, even when none is left to list. */}
      {signedOut && (
        <div data-testid="devices-signed-out-note">
          <SettingsNotice kind={signedOut.kind} role={signedOut.kind === 'error' ? 'alert' : 'status'}>{signedOut.line}</SettingsNotice>
        </div>
      )}
      {/* The extension uses no one way (its code works on every address): All devices lists it. */}
      {scope === 'all' && extensions.length > 0 && (
        <SettingsGroup
          heading="Walnut extension"
          headingTrailing={String(extensions.length)}
          description={`It signs in with a one-time code from Same Wi-Fi or ${tunnelName}, like a browser, and works on every address of this Walnut.`}
          data-testid="devices-extensions-group"
        >
          {extensions.map(renderRow)}
        </SettingsGroup>
      )}

      {scope === 'cloud' && (macs.length > 0 || selfRow) && (
        // This Mac's own link and the other Macs paired with the same companion.
        <SettingsGroup heading="Macs on this companion" data-testid="devices-macs">
          {selfRow && renderSelfRow(selfRow)}
          {macs.map(renderRow)}
        </SettingsGroup>
      )}
      {scope === 'all' && macs.length > 0 && (
        // Other Macs paired with the same companion: never phones, so no QR and no phone wording.
        <SettingsGroup heading="Other Macs" data-testid="devices-macs">
          {macs.map(renderRow)}
        </SettingsGroup>
      )}

      {scope === 'all' && pairGroup}

      {/* Not phones (this Mac's own cloud link, simulators): in Settings > Advanced, folded,
          so Phones & Cloud lists only what a person reaches Walnut with. */}
      {scope === 'advanced' && (others.length > 0 || selfRow || cloudUnpaired || cloudError) && (
        <SettingsGroup heading="Device records" data-testid="devices-others-group">
          {/* After Unpair this Mac (its row is gone), or while the companion does not answer (its row is unknown). */}
          {cloudUnpaired && <SettingsNotice kind="info">{CLOUD_UNPAIRED_NOTICE}</SettingsNotice>}
          {cloudError && <SettingsNotice kind="error" role="alert">{cloudError}</SettingsNotice>}
          <SettingsDisclosure
            id="devices-others"
            data-testid="devices-others"
            label="This Mac and test devices"
            help="This Mac's own link to the cloud companion, and iOS simulators. None of these is a phone."
            summary={String(others.length + (selfRow ? 1 : 0))}
          >
            {selfRow && renderSelfRow(selfRow)}
            {others.map(renderRow)}
          </SettingsDisclosure>
        </SettingsGroup>
      )}
      {qrDialog && (
        <PairQrDialog
          name={qrDialog.name}
          phase={qrDialog.phase}
          repair={qrDialog.repair}
          reach={reachWords(qrDialog.target)}
          created={created}
          qrDataURL={qrDataURL}
          error={qrDialog.error}
          onConfirm={() => void runMint(qrDialog)}
          onClose={closeQrDialog}
        />
      )}
    </div>
  );
}
