import { useState, useEffect, useCallback } from 'react';
import { SectionCard } from '../inputs/SectionCard';
import { SettingsEmpty, SettingsGroup, SettingsRow, SettingsTag, SettingsDisclosure, SettingsNotice } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { InlineConfirmButton } from '../inputs/InlineConfirmButton';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { saveErrorMessage, useSettingsSaved } from '../settings-pane-context';
import { formatAbsoluteTime } from './addons-format';
import { apiGet, apiDelete } from '@/api/client';
import { fetchDevicesList } from './cloud/devices-list';
import { log } from '@/utils/log';
import { PairingQrBlock } from './cloud/PairingQrBlock';
import { deviceNameForServer } from './device-name';
import { usePairDevice, type PairingTarget, type PairTargetKind } from './cloud/usePairDevice';

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
  role?: 'phone' | 'simulator' | 'self';
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

const ROLE_NOTE: Record<'simulator' | 'self', string> = {
  self: 'This computer, used for cloud sync; removing it breaks sync.',
  simulator: 'iOS Simulator on this computer (development).',
};

/**
 * Where a scanned QR points the phone. `cloud` works off Wi-Fi. Defined in
 * cloud/usePairDevice.ts — the Cloud Companion section pairs the same way.
 */
type TargetKind = PairTargetKind;

/** Re-pair via cloud when the device has one — it keeps working off Wi-Fi. */
function preferredKind(kinds: TargetKind[]): TargetKind {
  return kinds.includes('cloud') ? 'cloud' : 'lan';
}

/**
 * Paired devices (iOS app etc.) — list, revoke, and pair a new device by
 * showing a wn://pair QR code the Walnut iOS app scans. The token appears
 * exactly once (only its hash is stored server-side), so the QR block stays
 * visible until dismissed.
 *
 * Two pairing targets, because they are genuinely different credentials:
 * "This network" mints locally (same Wi-Fi only) and "Cloud" mints on the
 * cloud companion (works anywhere). Picking the wrong one is the classic
 * failure — a LAN QR scanned over cellular can never connect.
 */
export function DevicesSection() {
  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [cloudDevices, setCloudDevices] = useState<DeviceEntry[]>([]);
  const [targets, setTargets] = useState<PairingTarget[]>([]);
  // Until the list answers, nothing is known: no "No phones" line and no "no address" notice
  // that then vanish and pull a deep-linked section below them upward (C74).
  const [listState, setListState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [target, setTarget] = useState<TargetKind>('lan');
  const [newName, setNewName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  // Minting + QR rendering is shared with the Cloud Companion section.
  const { created, qrDataURL, error, busy, mint, dismiss } = usePairDevice();
  const [rowError, setRowError] = useState<{ name: string; message: string } | null>(null);
  const { track } = useSettingsSaved();

  const refresh = useCallback(async () => {
    try {
      const res = await fetchDevicesList<{ devices: DeviceEntry[]; cloudDevices?: DeviceEntry[]; targets?: PairingTarget[] }>();
      setDevices(res.devices);
      setCloudDevices(res.cloudDevices ?? []);
      const list = res.targets ?? [];
      setTargets(list);
      // Default to Cloud when it exists — a phone that leaves the house keeps
      // working, which is what people mean by "connect my phone".
      setTarget((prev) => (list.some((t) => t.kind === prev) ? prev : (list[list.length - 1]?.kind ?? 'lan')));
      setListState('ready');
    } catch (err) {
      log.error('settings', 'devices list failed', { error: String(err) });
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
    if (await mint({ name, target: kind, replace: true })) await refresh();
  };

  const addDevice = async () => {
    if (!newName.trim() || busy) return;
    // "My iPhone" is the natural shape; the server wants an id (N3-03).
    const name = deviceNameForServer(newName);
    if (!name) { setNameError('Use at least one letter or digit in the name.'); return; }
    setNameError(null);
    // Only send an explicit target when one was actually offered — otherwise
    // let the server pick (it falls back to a token-only QR).
    const chosen = targets.some((t) => t.kind === target) ? target : undefined;
    if (await mint({ name, target: chosen })) {
      setNewName('');
      await refresh();
    }
  };

  /**
   * Revoke EVERY credential behind a row. A phone paired to both this Mac and
   * the cloud has two tokens; killing one and leaving the other would still let
   * the device in, so "Revoke" must mean revoked.
   */
  const revoke = async (name: string, kinds: TargetKind[]) => {
    setRowError(null);
    try {
      await track((async () => {
        for (const kind of kinds) {
          await apiDelete(`/api/devices/${encodeURIComponent(name)}${kind === 'cloud' ? '?target=cloud' : ''}`);
        }
      })());
      await refresh();
    } catch (err) {
      setRowError({ name, message: saveErrorMessage(err) });
    }
  };

  const activeTarget = targets.find((t) => t.kind === target);
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
    cloudDevices.forEach((d) => add(d, 'cloud'));
    // Real phones first — the row the user came here for shouldn't sit under
    // this Mac's own sync credential.
    const rank = (r?: string) => (r === 'phone' || !r ? 0 : r === 'simulator' ? 1 : 2);
    return [...byName.values()].sort((a, b) => rank(a.role) - rank(b.role));
  })();
  const phones = rows.filter((r) => (r.role ?? 'phone') === 'phone');
  const others = rows.filter((r) => (r.role ?? 'phone') !== 'phone');

  const renderRow = (d: typeof rows[number]) => {
    const role = d.role ?? 'phone';
    const hw = role === 'phone' ? describeDevice(d.info) : null;
    const meta = role === 'phone'
      ? [
          hw ?? 'Model unknown until the app opens on this phone',
          `paired ${formatAbsoluteTime(d.createdAt)}`,
          ...(d.lastUsedAt ? [`last used ${formatAbsoluteTime(d.lastUsedAt)}`] : []),
        ].join(', ')
      : ROLE_NOTE[role];
    return (
      <SettingsRow
        key={d.name}
        className="devices-row"
        data-device-name={d.name}
        label={
          <span className="settings-addons-inline devices-name">
            <span className="settings-addons-ellipsis" title={d.name}>{d.name}</span>
            {d.kinds.map((k) => (
              <SettingsTag key={k}>{k === 'cloud' ? 'Cloud' : 'Local'}</SettingsTag>
            ))}
          </span>
        }
        help={<span className="devices-meta">{meta}</span>}
        error={rowError?.name === d.name ? `Couldn't remove: ${rowError.message}` : undefined}
        control={
          <>
            {role === 'phone' && (
              <InlineConfirmButton
                label="Show QR"
                confirmLabel="Confirm new QR"
                variant="text"
                disabled={busy}
                aria-label={`Show a new QR code for ${d.name}; its current token stops working`}
                data-testid="devices-show-qr"
                onConfirm={() => repair(d.name, preferredKind(d.kinds))}
              />
            )}
            {/* This Mac's own sync credential has no QR and must not be
                casually removed: that silently breaks cloud sync. */}
            {role !== 'self' && (
              <InlineConfirmButton
                aria-label={`Remove ${d.name}`}
                data-testid="devices-remove"
                onConfirm={() => revoke(d.name, d.kinds)}
              />
            )}
          </>
        }
      />
    );
  };

  return (
    <SectionCard id="devices" title="Phones & Cloud">
      <div className="devices-section">
        <SettingsGroup heading="Paired phones">
          {phones.length === 0 && (
            <SettingsEmpty>
              {listState === 'loading' ? 'Loading paired phones...'
                : listState === 'failed' ? "Couldn't load paired phones." : 'No phones paired yet.'}
            </SettingsEmpty>
          )}
          {phones.map(renderRow)}
          {others.length > 0 && (
            <SettingsDisclosure
              id="devices-others"
              label="Other entries"
              help="This computer and simulators."
              summary={String(others.length)}
            >
              {others.map(renderRow)}
            </SettingsDisclosure>
          )}
        </SettingsGroup>

        <SettingsGroup heading="Pair a phone">
          {targets.length > 1 && (
            <SettingsRow
              label="Pairing target"
              help={activeTarget
                ? activeTarget.kind === 'cloud'
                  ? 'Works from anywhere, including cellular; the token is created on your cloud companion.'
                  : <>Works only while the phone is on the same <span className="settings-nowrap">Wi-Fi</span> as this Mac.</>
                : undefined}
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
            help={targets.length === 1 && activeTarget?.kind === 'lan'
              ? <>Pair a phone by scanning a QR code; this one works only on the same <span className="settings-nowrap">Wi-Fi</span> as this Mac.</>
              : 'Pair a phone by scanning a QR code with the Walnut iOS app.'}
            error={nameError ?? (!created && error ? error : undefined)}
            control={
              <span className="settings-addons-inline devices-add-row">
                <input
                  id="devices-new-name"
                  type="text"
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
          {created && error && <p className="settings-row-error devices-error" role="alert">{error}</p>}
          {created && qrDataURL && (
            <PairingQrBlock created={created} qrDataURL={qrDataURL} onDismiss={dismiss} />
          )}
        </SettingsGroup>
      </div>
    </SectionCard>
  );
}
