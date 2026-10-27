import { Fragment, useState, useEffect, useCallback, useRef } from 'react';
import { getDeviceToken } from '@/api/device-token';
import { SectionCard } from '../inputs/SectionCard';
import { SettingsEmpty, SettingsGroup, SettingsRow, SettingsTag, SettingsDisclosure, SettingsNotice } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { InlineConfirmButton } from '../inputs/InlineConfirmButton';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { useSettingsSaved } from '../settings-pane-context';
import { formatAbsoluteTime } from './addons-format';
import { apiGet, apiDelete } from '@/api/client';
import { devicesListChanged, fetchDevicesList } from './cloud/devices-list';
import { log } from '@/utils/log';
import { PairingQrBlock } from './cloud/PairingQrBlock';
import { requestFailureText } from '@/utils/request-failure';
import { deviceNameForServer } from './device-name';
import { browserRowLabels } from './browser-labels';
import { usePairDevice, type PairingTarget, type PairTargetKind } from './cloud/usePairDevice';
import { bestOfferedKind, preferredKind } from './cloud/pair-targets';
import { useIsCloudReplica } from '@/hooks/useIsCloudReplica';
import { useDraft } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';
import { RemoteAccessCard } from './cloud/RemoteAccessCard';
import { BackupLeaderGroup } from './cloud/BackupLeaderGroup';
import { CompanionKeepGroup } from './cloud/CompanionKeepGroup';
import { BrowserAccessGroup } from './cloud/BrowserAccessGroup';
import type { Config } from '@open-walnut/core';
import { CLOUD_CHANGE_CLIENT_TIMEOUT_MS } from './cloud/cloud-change-timeout';
import { isIosSafariTab, ownFirst, useDeviceCaller } from './cloud/device-caller';
import { OwnDeviceSignOut } from './cloud/OwnDeviceSignOut';

import '@/styles/settings-sections-addons.css';

/** Self-reported hardware identity, absent until the phone checks in once. */
interface DeviceSelfInfo {
  model?: string;
  os?: string;
  deviceName?: string;
  appVersion?: string;
  reportedAt?: string;
}

interface DeviceEntry {
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  /** What this credential actually is: not everything in the list is a phone. */
  role?: 'phone' | 'simulator' | 'mac' | 'self' | 'browser';
  info?: DeviceSelfInfo;
}

/**
 * A raw hardware id (`iPhone18,2`) reads as its family (`iPhone`): the id means
 * nothing to a person and a model table would go stale (F24).
 */
export function humanDeviceModel(model?: string): string | undefined {
  if (!model) return undefined;
  const m = /^(iPhone|iPad|iPod|Watch|Mac)\d+,\d+$/.exec(model.trim());
  if (!m) return model;
  return m[1] === 'Watch' ? 'Apple Watch' : m[1] === 'iPod' ? 'iPod touch' : m[1];
}

/** "iPhone, iOS 26.1, Walnut 1.0 (26)": omits whatever wasn't reported. */
export function describeDevice(info?: DeviceSelfInfo): string | null {
  if (!info) return null;
  const parts = [humanDeviceModel(info.model), info.os, info.appVersion ? `Walnut ${info.appVersion}` : undefined]
    .filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(', ') : null;
}

/** Said in place of the cloud half after this Mac unpaired itself: a state, not an error. */
export const CLOUD_UNPAIRED_NOTICE = 'This Mac is no longer paired with the cloud companion.';

/** Settings › Cloud Companion listens, so its "Connected" never outlives an unpair made here. */
export const DEVICES_CHANGED_EVENT = 'walnut:devices-changed';


/** "Mac, Walnut 0.5.1, paired …, last used …": a Mac's row says nothing about phones. */
export function describeMacRow(d: DeviceEntry): string {
  const model = humanDeviceModel(d.info?.model);
  return [
    ...(model && model !== 'Computer' ? [model] : []),
    ...(d.info?.appVersion ? [`Walnut ${d.info.appVersion}`] : []),
    `paired ${formatAbsoluteTime(d.createdAt)}`,
    ...(d.lastUsedAt ? [`last used ${formatAbsoluteTime(d.lastUsedAt)}`] : []),
  ].join(', ');
}

const ROLE_NOTE: Record<'simulator' | 'self' | 'browser', string> = {
  self: "This Mac's own pairing with the cloud companion. Cloud sync, your phones' way to this Mac, and the Cloud host run on it.",
  simulator: 'iOS Simulator on this computer (development).',
  browser: 'A browser you signed in with a code; removing it signs that browser out.',
};

/** Said before "Unpair this Mac" goes through: what stops working, and the way back. */
export const UNPAIR_SELF_WARNING =
  'Unpairing this Mac stops cloud sync, cuts your phones off from this Mac through the companion, and takes the Cloud host offline. Pairing it again needs a new token made on the companion.';

type RowError = { name: string; verb: 'remove' | 're-pair' | 'unpair'; message: string };

/**
 * Where a scanned QR points the phone: this network, the tailnet or the cloud.
 * Defined in cloud/usePairDevice.ts; the Cloud Companion section pairs the same way.
 */
type TargetKind = PairTargetKind;

/** GET /api/devices (its `tailscale` summary is read by the card through its own endpoint). */
interface DevicesListResponse {
  devices: DeviceEntry[];
  cloudDevices?: DeviceEntry[];
  targets?: PairingTarget[];
}

/**
 * Paired devices (iOS app etc.) — list, revoke, and pair a new device by
 * showing a wn://pair QR code the Walnut iOS app scans. The token appears
 * exactly once (only its hash is stored server-side), so the QR block stays
 * visible until dismissed.
 *
 * The picker only chooses which address goes in the QR. A phone paired through
 * any address learns the other addresses by itself, so pick the one the phone
 * can reach right now: a Wi-Fi QR scanned over cellular never connects at all.
 */
export function DevicesSection({ config, onSave }: { config?: Config; onSave?: (partial: Partial<Config>) => Promise<void> } = {}) {
  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [cloudDevices, setCloudDevices] = useState<DeviceEntry[]>([]);
  const [targets, setTargets] = useState<PairingTarget[]>([]);
  const replica = useIsCloudReplica();
  // Until the list answers, nothing is known: no "No phones" line and no "no address" notice
  // that then vanish and pull a deep-linked section below them upward (C74).
  const [listState, setListState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [target, setTarget] = useState<TargetKind>('lan');
  // A device name typed and not paired yet survives leaving the pane; a successful pairing ends it.
  const nameDraft = useDraft(draftKey('pair-device-name', 'new'));
  const { text: newName, setText: setNewName } = nameDraft;
  const [nameError, setNameError] = useState<string | null>(null);
  // Minting + QR rendering is shared with the Cloud Companion section.
  const { created, qrDataURL, error, busy, mint, dismiss } = usePairDevice();
  const [rowError, setRowError] = useState<RowError | null>(null);
  // The cloud half of the list failed to load (the reason, from the server):
  // said in the section, never shown as "no phones".
  const [cloudError, setCloudError] = useState<string | null>(null);
  // This Mac unpaired itself: the cloud half is gone on purpose, said plainly.
  const [cloudUnpaired, setCloudUnpaired] = useState(false);
  // "Unpair this Mac" is two deliberate clicks with the warning between them.
  const [unpairArmed, setUnpairArmed] = useState(false);
  // Show QR on a row: the row asks first (a new code signs the phone out), and the
  // code opens under that row, never at the bottom of the page.
  const [qrAsk, setQrAsk] = useState<string | null>(null);
  const [qrRow, setQrRow] = useState<string | null>(null);
  const [mintingRow, setMintingRow] = useState<string | null>(null);
  const closeQr = () => { dismiss(); setQrRow(null); };
  const { notifySaved } = useSettingsSaved();
  // A browser signed in with a code: its own row says so, other rows offer no Remove.
  const caller = useDeviceCaller();
  // Only a Safari tab signed in with a token can lose it after a week (N2-36):
  // a tab on the Mac's own address holds none, so the tip would say nothing true.
  const [homeScreenHint] = useState(() => isIosSafariTab() && !!getDeviceToken());

  // Reads can land out of order (a pairing's read can beat the pane's first one):
  // only the newest read writes the list.
  const readSeq = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++readSeq.current;
    try {
      const res = await fetchDevicesList<DevicesListResponse & { cloudError?: string; cloudUnpaired?: { origin: string } }>();
      if (seq !== readSeq.current) return;
      setDevices(res.devices);
      setCloudDevices(res.cloudDevices ?? []);
      setCloudError(res.cloudError ?? null);
      setCloudUnpaired(Boolean(res.cloudUnpaired));
      const list = res.targets ?? [];
      setTargets(list);
      // Keep the current pick while it is still offered. The first pick is this
      // network when there is one (the phone usually pairs next to this machine,
      // then learns the other addresses), else Cloud, else the tailnet.
      setTarget((prev) => (list.some((t) => t.kind === prev) ? prev : bestOfferedKind(list.map((t) => t.kind))));
      setListState('ready');
    } catch (err) {
      log.error('settings', 'devices list failed', { error: String(err) });
      if (seq !== readSeq.current) return;
      setListState((prev) => (prev === 'ready' ? prev : 'failed'));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Re-pair an existing device: mint a FRESH token for the same name and show
   * the QR again. Needed because tokens are one-time — after an app reinstall
   * iOS wipes UserDefaults (server URL + device name), so the phone has to be
   * re-paired, and there is nothing to "show again". Rotating in place beats
   * making the user Revoke-then-Add by hand.
   */
  const repair = async (name: string, kind: TargetKind) => {
    if (busy) return;
    // Two-step button (InlineConfirmButton) instead of window.confirm: the Mac
    // app's WKWebView has no confirm panel, so confirm() was a silent Cancel.
    // Keep the picker on the device's OWN target — re-pairing a cloud phone
    // must not silently flip the UI back to the Wi-Fi default.
    setTarget(kind);
    setRowError(null);
    setQrAsk(null);
    // Any QR on screen is replaced by this one, so the bottom one closes too.
    dismiss();
    setQrRow(name);
    setMintingRow(name);
    // A refusal belongs on the row that was clicked, not under "Device name".
    const onError = (message: string) => setRowError({ name, verb: 're-pair', message });
    try {
      if (await mint({ name, target: kind, replace: true, onError })) await refresh();
    } finally {
      setMintingRow((cur) => (cur === name ? null : cur));
    }
  };

  const addDevice = async () => {
    if (!newName.trim() || busy) return;
    // "My iPhone" is the natural shape; the server wants an id (N3-03).
    const name = deviceNameForServer(newName);
    if (!name) { setNameError('Use at least one letter or digit in the name.'); return; }
    setNameError(null);
    // A row's code must never move down here and pass for the new device's.
    closeQr();
    // Only send an explicit target when one was actually offered — otherwise
    // let the server pick (it falls back to a token-only QR).
    const chosen = targets.some((t) => t.kind === target) ? target : undefined;
    const sentKey = nameDraft.key;
    if (await mint({ name, target: chosen })) {
      nameDraft.clear(sentKey);
      await refresh();
    }
  };

  /**
   * Revoke EVERY credential behind a row. A phone paired to both this Mac and
   * the cloud has two tokens; killing one and leaving the other would still let
   * the device in, so "Revoke" must mean revoked.
   */
  const revoke = async (name: string, kinds: TargetKind[], verb: RowError['verb'] = 'remove') => {
    setRowError(null);
    let waitedMs = 15_000;
    try {
      for (const kind of kinds) {
        waitedMs = kind === 'cloud' ? CLOUD_CHANGE_CLIENT_TIMEOUT_MS : 15_000;
        await apiDelete(`/api/devices/${encodeURIComponent(name)}${kind === 'cloud' ? '?target=cloud' : ''}`, { timeoutMs: waitedMs });
        devicesListChanged();
      }
      notifySaved();
      // Its code was revoked with it.
      if (qrRow === name) closeQr();
      await refresh();
      window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT));
    } catch (err) {
      // A refused or failed removal is an answer about this device, not an
      // unsaved settings change: it shows on the row only, and the page's
      // Saved / Not saved indicator is left as it was.
      setRowError({ name, verb, message: requestFailureText(err, waitedMs) });
    }
  };

  const activeTarget = targets.find((t) => t.kind === target);
  const showPicker = targets.length > 1;
  // How to reach Walnut from anywhere without a cloud server: the guided card
  // (cloud/RemoteAccessCard.tsx), on a primary only (a companion has nothing to install).
  const showRemoteCard = !replica;
  const chooseTailnet = () => {
    setTarget('tailnet');
    document.getElementById('devices-new-name')?.focus();
  };
  const targetHelp = activeTarget?.kind === 'cloud'
    ? 'Works from anywhere, including cellular; the token is created on your cloud companion.'
    : activeTarget?.kind === 'tailnet'
      ? 'Works anywhere the phone is on the same tailnet as this machine, including cellular.'
      : activeTarget
        ? <>Works only while the phone is on the same <span className="settings-nowrap">Wi-Fi</span> as this Mac.</>
        : undefined;
  const nameHelp = targets.length === 1 && activeTarget?.kind === 'lan'
    ? <>Pair a phone by scanning a QR code; this one works only on the same <span className="settings-nowrap">Wi-Fi</span> as this Mac.</>
    : targets.length === 1 && activeTarget?.kind === 'tailnet'
      ? 'Pair a phone by scanning a QR code; this one works anywhere the phone is on the same tailnet as this machine.'
      : 'Pair a phone by scanning a QR code with the Walnut iOS app.';
  // ONE row per physical device. The same phone is usually paired to both this
  // Mac and the cloud, and listing each credential separately showed the same
  // name twice — indistinguishable rows that made a 2-device setup look like 9.
  // Merge by name, keep both badges, and act on the credential that matches the
  // button the user pressed.
  const rows = (() => {
    const byName = new Map<string, DeviceEntry & { kinds: TargetKind[] }>();
    const add = (d: DeviceEntry, kind: TargetKind) => {
      const existing = byName.get(d.name);
      if (existing) {
        existing.kinds.push(kind);
        // Show the most recent activity across both credentials.
        if (d.lastUsedAt && (!existing.lastUsedAt || d.lastUsedAt > existing.lastUsedAt)) {
          existing.lastUsedAt = d.lastUsedAt;
        }
        return;
      }
      byName.set(d.name, { ...d, kinds: [kind] });
    };
    devices.forEach((d) => add(d, 'lan'));
    // This Mac's own cloud record is its own row (renderSelfRow), never merged
    // with a phone that happens to share its name.
    cloudDevices.forEach((d) => { if (d.role !== 'self') add(d, 'cloud'); });
    // Real phones first — the row the user came here for shouldn't sit under
    // this Mac's own sync credential.
    const rank = (r?: string) => (r === 'phone' || !r ? 0 : r === 'mac' ? 1 : r === 'simulator' ? 2 : 3);
    return [...byName.values()].sort((a, b) => rank(a.role) - rank(b.role));
  })();
  const selfRow = cloudDevices.find((d) => d.role === 'self');
  const phones = ownFirst(rows.filter((r) => (r.role ?? 'phone') === 'phone'), caller.name);
  const browsers = ownFirst(rows.filter((r) => r.role === 'browser'), caller.name);
  // "iPhone Safari", "iPhone Safari 2": the kind recorded at sign-in, never the id (N2-21).
  const browserLabels = browserRowLabels(rows.filter((r) => r.role === 'browser'));
  const macs = rows.filter((r) => r.role === 'mac');
  const others = rows.filter((r) => (r.role ?? 'phone') !== 'phone' && r.role !== 'mac' && r.role !== 'browser');
  // Keyboard focus follows the ask: a button that unmounts would drop it to the page.
  const focusShowQr = (name: string) => requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`#devices .devices-row[data-device-name="${CSS.escape(name)}"] [data-testid="devices-show-qr"]`)?.focus();
  });
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
          <SettingsTag>Cloud</SettingsTag>
        </span>
      }
      help={<span className="devices-meta">{`${d.name}: ${ROLE_NOTE.self}`}</span>}
      error={rowErrorFor(d.name)}
      control={unpairArmed ? (
        <>
          <SettingsButton variant="text" data-testid="devices-unpair-self-cancel" onClick={() => setUnpairArmed(false)}>
            Cancel
          </SettingsButton>
          <SettingsButton
            variant="danger"
            data-testid="devices-unpair-self-confirm"
            onClick={() => { setUnpairArmed(false); void revoke(d.name, ['cloud'], 'unpair'); }}
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

  const renderRow = (d: typeof rows[number]) => {
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
      // A signed-in browser says when it signed in and was last used, so two
      // rows can be told apart (N18); the one-line role note was the same on all.
      : role === 'browser' ? [
          `signed in ${formatAbsoluteTime(d.createdAt)}`,
          ...(d.lastUsedAt ? [`last used ${formatAbsoluteTime(d.lastUsedAt)}`] : []),
        ].join(', ')
      : ROLE_NOTE[role];
    const row = (
      <SettingsRow
        key={d.name}
        className="devices-row"
        data-device-name={d.name}
        data-device-role={role}
        label={
          <span className="settings-addons-inline devices-name">
            <span className="settings-addons-ellipsis" title={d.name}>{role === 'browser' ? browserLabels.get(d.name) ?? 'Browser' : d.name}</span>
            {own && <span className="devices-own-tag" data-testid="devices-own-tag">{caller.touch ? 'This phone' : 'This browser'}</span>}
            {/* A browser signs in on this Mac only: a "Local" tag on every row tells nothing. */}
            {role !== 'browser' && d.kinds.map((k) => (
              <SettingsTag key={k}>{k === 'cloud' ? 'Cloud' : 'Local'}</SettingsTag>
            ))}
          </span>
        }
        help={<span className="devices-meta">{meta}</span>}
        error={rowErrorFor(d.name)}
        data-own-device={own ? 'true' : undefined}
        control={own ? <OwnDeviceSignOut name={d.name} touch={caller.touch} /> : caller.isDevice ? undefined : (
          <>
            {role === 'phone' && (qrAsk === d.name ? (
              <>
                <SettingsButton variant="text" data-testid="devices-show-qr-cancel" onClick={() => { setQrAsk(null); focusShowQr(d.name); }}>
                  Cancel
                </SettingsButton>
                <SettingsButton
                  variant="primary"
                  data-testid="devices-show-qr-confirm"
                  autoFocus
                  disabled={busy}
                  onClick={() => { focusShowQr(d.name); void repair(d.name, preferredKind(d.kinds, targets.map((t) => t.kind))); }}
                >
                  Show new QR
                </SettingsButton>
              </>
            ) : (
              <SettingsButton
                variant="text"
                disabled={busy && mintingRow !== d.name}
                busy={mintingRow === d.name}
                busyLabel="Making QR..."
                aria-label={`Show a new QR code for ${d.name}`}
                data-testid="devices-show-qr"
                onClick={() => { setRowError(null); setQrAsk(d.name); }}
              >
                Show QR
              </SettingsButton>
            ))}
            {/* This Mac's own cloud record never reaches here (renderSelfRow). */}
            {role !== 'self' && qrAsk !== d.name && (
              <InlineConfirmButton
                aria-label={`Remove ${d.name}`}
                data-testid="devices-remove"
                onConfirm={() => revoke(d.name, d.kinds)}
              />
            )}
          </>
        )}
      >
        {qrAsk === d.name && (
          <SettingsNotice kind="warn" role="alert">
            {`A new code replaces the one ${d.name} signed in with, so the app stops connecting until it scans the new code.`}
          </SettingsNotice>
        )}
      </SettingsRow>
    );
    // The new code opens right under the row it was asked for. Always a Fragment,
    // so the row is not remounted (and focus not lost) when the code opens or closes.
    return (
      <Fragment key={d.name}>
        {row}
        {role === 'phone' && qrRow === d.name && created && qrDataURL && (
          <PairingQrBlock created={created} qrDataURL={qrDataURL} onDismiss={closeQr} repair />
        )}
      </Fragment>
    );
  };

  return (
    <SectionCard id="devices" title="Phones & Cloud">
      <div className="devices-section">
        {homeScreenHint && (
          <p className="settings-row-help devices-home-screen-hint" data-testid="devices-home-screen-hint">
            Add Walnut to your Home Screen (Share &gt; Add to Home Screen) to keep this phone signed in. Safari may sign it
            out after a week without a visit.
          </p>
        )}
        {/* A phone signed in only by browser: its group is Signed-in browsers, no empty box here. */}
        {(phones.length > 0 || listState !== 'ready' || browsers.length === 0 || cloudUnpaired || cloudError) && (
        <SettingsGroup heading="Paired phones" data-testid="devices-phones-group">
          {phones.length === 0 && (listState !== 'ready' || browsers.length === 0) && (
            <SettingsEmpty>
              {listState === 'loading' ? 'Loading paired phones...'
                : listState === 'failed' ? "Couldn't load paired phones."
                  // The cloud's half is unknown: say only what is known.
                  : cloudError || cloudUnpaired ? 'No phones paired with this Mac.' : 'No phones paired yet.'}
            </SettingsEmpty>
          )}
          {phones.map(renderRow)}
          {cloudUnpaired && <SettingsNotice kind="info">{CLOUD_UNPAIRED_NOTICE}</SettingsNotice>}
          {cloudError && <SettingsNotice kind="error" role="alert">{cloudError}</SettingsNotice>}
        </SettingsGroup>
        )}

        {browsers.length > 0 && (
          // Browsers signed in with a code (a phone's Safari, another computer):
          // their own group, so a signed-in phone never reads "No phones paired yet".
          <SettingsGroup heading="Signed-in browsers" headingTrailing={String(browsers.length)} data-testid="devices-browsers-group">
            {browsers.map(renderRow)}
          </SettingsGroup>
        )}

        {macs.length > 0 && (
          // Other Macs paired with the same companion: never phones, so no QR and
          // no phone wording. Remove stays, under the same rules as any device.
          <SettingsGroup heading="Other Macs" data-testid="devices-macs">
            {macs.map(renderRow)}
          </SettingsGroup>
        )}

        {showRemoteCard && (
          <RemoteAccessCard
            devices={listState === 'ready' ? [...devices, ...cloudDevices] : null}
            tailnetOffered={targets.some((t) => t.kind === 'tailnet')}
            onChooseTailnet={chooseTailnet}
            onTailnetChange={refresh}
          />
        )}

        {/* A tunnel and browser codes: a companion is reached through its own address. */}
        {!replica && <BrowserAccessGroup />}

        {/* Only with a cloud companion to take over, and only on the Mac it would stand in for. */}
        {!replica && config && onSave && targets.some((t) => t.kind === 'cloud') && (
          <BackupLeaderGroup config={config} onSave={onSave} />
        )}

        {/* What the companion keeps: the same rows and defaults as a host's (Remote Hosts). */}
        {!replica && config && onSave && targets.some((t) => t.kind === 'cloud') && (
          <CompanionKeepGroup config={config} onSave={onSave} />
        )}

        <SettingsGroup heading="Pair a phone">
          {/* Three long labels left the copy a word-wide column beside them: stack the row. */}
          {showPicker && (
            <SettingsRow
              label="Pairing target"
              className={targets.length > 2 ? 'settings-row-stacked' : undefined}
              help={targetHelp}
              control={
                <SegmentedControl
                  aria-label="Pairing target"
                  value={target}
                  onChange={(v) => setTarget(v)}
                  options={targets.map((t) => ({
                    value: t.kind,
                    label: t.label,
                    title: t.origin.replace(/^https?:\/\//, ''),
                    testId: `devices-target-${t.kind}`,
                  }))}
                />
              }
            />
          )}
          {listState === 'ready' && targets.length === 0 && (
            <SettingsNotice kind="info">
              No address for this machine can be detected, so the QR carries only the token and you type the
              server address in the app; for one-tap pairing from anywhere, <a href="#cloud">set up a cloud companion</a>.
            </SettingsNotice>
          )}
          <SettingsRow
            label="Device name"
            htmlFor="devices-new-name"
            wide
            help={nameHelp}
            error={nameError ?? (!created && error ? error : undefined)}
            control={
              <span className="settings-addons-inline devices-add-row">
                <input
                  id="devices-new-name"
                  type="text"
                  data-draft-key={nameDraft.key ?? undefined}
                  className="settings-input settings-input--short"
                  value={newName}
                  placeholder="My iPhone"
                  onChange={(e) => { setNewName(e.target.value); setNameError(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addDevice(); } }}
                />
                <SettingsButton
                  variant="primary"
                  disabled={!newName.trim()}
                  title={newName.trim() ? undefined : 'Name the device first.'}
                  busy={busy}
                  busyLabel="Pairing..."
                  onClick={() => void addDevice()}
                >
                  Pair new device
                </SettingsButton>
              </span>
            }
          />
          {created && !qrRow && error && <p className="settings-row-error devices-error" role="alert">{error}</p>}
          {created && !qrRow && qrDataURL && (
            <PairingQrBlock created={created} qrDataURL={qrDataURL} onDismiss={closeQr} />
          )}
        </SettingsGroup>

        {/* Not phones (this Mac's own cloud link, simulators): folded at the very end,
            so the phones list holds only phones. */}
        {(others.length > 0 || selfRow) && (
          <SettingsGroup heading="Advanced" data-testid="devices-others-group">
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
      </div>
    </SectionCard>
  );
}
