import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getDeviceToken } from '@/api/device-token';
import { SectionCard } from '../inputs/SectionCard';
import { SettingsEmpty, SettingsGroup, SettingsRow, SettingsTag, SettingsDisclosure, SettingsNotice } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { InlineConfirmButton } from '../inputs/InlineConfirmButton';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { useSettingsSaved } from '../settings-pane-context';
import { formatAbsoluteTime } from './addons-format';
import { apiDelete } from '@/api/client';
import { devicesListChanged } from './cloud/devices-list';
import { PairQrDialog, type PairQrPhase } from './cloud/PairQrDialog';
import { WaysOverview } from './cloud/WaysOverview';
import { useBrowserLinkName } from './cloud/browser-link-name';
import { deriveWays, type WayId } from './cloud/ways-model';
import { WAY_PANES } from '../settings-way-panes';
import { requestFailureText } from '@/utils/request-failure';
import { deviceNameForServer } from './device-name';
import { browserRowLabels } from './browser-labels';
import { usePairDevice, type PairTargetKind } from './cloud/usePairDevice';
import { clearRequestedPairTarget, peekRequestedPairTarget, useDevicesData, useExposeStatus, type DeviceEntry } from './cloud/useDevicesData';
import { bestOfferedKind, preferredKind } from './cloud/pair-targets';
import { useIsCloudReplica } from '@/hooks/useIsCloudReplica';
import { useDraft } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';
import { CLOUD_CHANGE_CLIENT_TIMEOUT_MS } from './cloud/cloud-change-timeout';
import { isIosSafariTab, ownFirst, useDeviceCaller } from './cloud/device-caller';
import { OwnDeviceSignOut } from './cloud/OwnDeviceSignOut';
import { describeDevice, describeMacRow, reachWords, ROLE_NOTE, UNPAIR_SELF_WARNING, CLOUD_UNPAIRED_NOTICE, DEVICES_CHANGED_EVENT } from './cloud/device-rows-copy';

import '@/styles/settings-sections-addons.css';

export { humanDeviceModel, describeDevice, describeMacRow, CLOUD_UNPAIRED_NOTICE, DEVICES_CHANGED_EVENT, UNPAIR_SELF_WARNING } from './cloud/device-rows-copy';

type RowError = { name: string; verb: 'remove' | 're-pair' | 'unpair'; message: string };

/**
 * Where a scanned QR points the phone: this network, the tailnet or the cloud.
 * Defined in cloud/usePairDevice.ts; the Cloud Companion section pairs the same way.
 */
type TargetKind = PairTargetKind;

/** The pairing QR dialog: which phone, whether it replaces a paired phone's code, and its step. */
interface QrDialogState {
  name: string;
  repair: boolean;
  target?: TargetKind;
  phase: PairQrPhase;
  error: string | null;
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
export function DevicesSection() {
  const replica = useIsCloudReplica();
  const navigate = useNavigate();
  const [target, setTarget] = useState<TargetKind>('lan');
  // "Use the tailnet address" on the Tailscale sub-page: picked here once the list offers it.
  const [firstWanted] = useState(peekRequestedPairTarget);
  const wantedTarget = useRef<TargetKind | null>(firstWanted);
  useEffect(() => clearRequestedPairTarget(), []);
  const [focusName, setFocusName] = useState(false);
  // Keep the current pick while it is still offered. The first pick is this network when
  // there is one (the phone usually pairs next to this machine, then learns the other
  // addresses), else Cloud, else the tailnet.
  const data = useDevicesData({
    replica,
    onTargets: (kinds) => {
      // Asked for once, by the list this pane reads first: a later read never overrides a pick.
      const wanted = wantedTarget.current;
      wantedTarget.current = null;
      if (wanted && kinds.includes(wanted)) {
        setTarget(wanted);
        setFocusName(true);
        return;
      }
      setTarget((prev) => (kinds.includes(prev) ? prev : bestOfferedKind(kinds)));
    },
  });
  const { devices, cloudDevices, targets, listState, tailscale, cloudError, cloudUnpaired, cloudWithheld, refresh } = data;
  useEffect(() => {
    if (!focusName) return;
    setFocusName(false);
    document.getElementById('devices-new-name')?.focus();
  }, [focusName]);
  // A device name typed and not paired yet survives leaving the pane; a successful pairing ends it.
  const nameDraft = useDraft(draftKey('pair-device-name', 'new'));
  const { text: newName, setText: setNewName } = nameDraft;
  const [nameError, setNameError] = useState<string | null>(null);
  // Minting + QR rendering is shared with the Cloud Companion section.
  const { created, qrDataURL, error, busy, mint, dismiss } = usePairDevice();
  const [rowError, setRowError] = useState<RowError | null>(null);
  // "Unpair this Mac" is two deliberate clicks with the warning between them.
  const [unpairArmed, setUnpairArmed] = useState(false);
  // Show QR and Pair new device: the code opens in a dialog in front of the user.
  const [qrDialog, setQrDialog] = useState<QrDialogState | null>(null);
  const qrReturnFocus = useRef<HTMLElement | null>(null);
  const expose = useExposeStatus(replica);
  const linkName = useBrowserLinkName();
  const { notifySaved } = useSettingsSaved();
  // A browser signed in with a code: its own row says so, other rows offer no Remove.
  const caller = useDeviceCaller();
  // Only a Safari tab signed in with a token can lose it after a week (N2-36):
  // a tab on the Mac's own address holds none, so the tip would say nothing true.
  const [homeScreenHint] = useState(() => isIosSafariTab() && !!getDeviceToken());

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
  const runMint = async (dlg: QrDialogState) => {
    if (busy) return;
    setQrDialog({ ...dlg, phase: 'working', error: null });
    let failure: string | null = null;
    const made = await mint({ name: dlg.name, target: dlg.target, replace: dlg.repair || undefined, onError: (m) => { failure = m; } });
    setQrDialog((cur) => (cur && cur.name === dlg.name
      ? { ...cur, phase: made ? 'shown' : 'failed', error: made ? null : failure }
      : cur));
    if (made) {
      if (!dlg.repair) nameDraft.clear(nameDraft.key);
      await refresh();
    }
  };

  /**
   * Re-pair an existing device: mint a FRESH token for the same name and show
   * the QR again. Needed because tokens are one-time — after an app reinstall
   * iOS wipes UserDefaults (server URL + device name), so the phone has to be
   * re-paired, and there is nothing to "show again". Rotating in place beats
   * making the user Revoke-then-Add by hand. The dialog asks first: the new code
   * signs the phone out until it scans it.
   */
  const repair = (name: string, kind: TargetKind) => {
    if (busy) return;
    // Keep the picker on the device's OWN target — re-pairing a cloud phone
    // must not silently flip the UI back to the Wi-Fi default.
    setTarget(kind);
    setRowError(null);
    dismiss();
    openQrDialog({ name, repair: true, target: kind, phase: 'ask', error: null });
  };

  const addDevice = async () => {
    if (!newName.trim() || busy) return;
    // "My iPhone" is the natural shape; the server wants an id (N3-03).
    const name = deviceNameForServer(newName);
    if (!name) { setNameError('Use at least one letter or digit in the name.'); return; }
    setNameError(null);
    dismiss();
    // Only send an explicit target when one was actually offered — otherwise
    // let the server pick (it falls back to a token-only QR).
    const chosen = targets.some((t) => t.kind === target) ? target : undefined;
    const dlg: QrDialogState = { name, repair: false, target: chosen, phase: 'working', error: null };
    openQrDialog(dlg);
    await runMint(dlg);
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
  // The phone used most recently leads: it is the one the line above the cards is about.
  const byLastUse = (a: { lastUsedAt?: string }, b: { lastUsedAt?: string }) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '');
  const phones = ownFirst(rows.filter((r) => (r.role ?? 'phone') === 'phone').sort(byLastUse), caller.name);
  const browsers = ownFirst(rows.filter((r) => r.role === 'browser'), caller.name);
  // "iPhone Safari", "iPhone Safari 2": the kind recorded at sign-in, never the id (N2-21).
  const browserLabels = browserRowLabels(rows.filter((r) => r.role === 'browser'));
  const macs = rows.filter((r) => r.role === 'mac');
  const others = rows.filter((r) => (r.role ?? 'phone') !== 'phone' && r.role !== 'mac' && r.role !== 'browser');
  // How the phone reaches Walnut now and the three ways (cloud/ways-model.ts): a primary only.
  const showWays = !replica;
  const isPhone = (d: DeviceEntry) => (d.role ?? 'phone') === 'phone';
  const waysView = deriveWays({
    listState,
    phoneUses: [
      ...devices.filter(isPhone).map((d) => ({ name: d.name, via: 'lan' as const, lastUsedAt: d.lastUsedAt })),
      ...cloudDevices.filter(isPhone).map((d) => ({ name: d.name, via: 'cloud' as const, lastUsedAt: d.lastUsedAt })),
    ],
    targets,
    cloudError,
    cloudUnpaired,
    cloudWithheld,
    tailscale,
    expose,
    linkName,
  });
  // Each way is its own sub-page (Settings > Phones & Cloud > Tailscale): a card drills in.
  const onWayAction = (id: WayId) => navigate({ hash: `#${WAY_PANES[id]}` }, { replace: true });
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
          <SettingsTag>Cloud companion</SettingsTag>
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
    return (
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
              <SettingsTag key={k}>{k === 'cloud' ? 'Cloud companion' : 'Direct'}</SettingsTag>
            ))}
          </span>
        }
        help={<span className="devices-meta">{meta}</span>}
        error={rowErrorFor(d.name)}
        data-own-device={own ? 'true' : undefined}
        control={own ? <OwnDeviceSignOut name={d.name} touch={caller.touch} /> : caller.isDevice ? undefined : (
          <>
            {role === 'phone' && (
              <SettingsButton
                variant="text"
                disabled={busy}
                aria-label={`Show a new QR code for ${d.name}`}
                data-testid="devices-show-qr"
                onClick={() => repair(d.name, preferredKind(d.kinds, targets.map((t) => t.kind)))}
              >
                Show QR
              </SettingsButton>
            )}
            {/* This Mac's own cloud record never reaches here (renderSelfRow). */}
            {role !== 'self' && (
              <InlineConfirmButton
                aria-label={`Remove ${d.name}`}
                data-testid="devices-remove"
                onConfirm={() => revoke(d.name, d.kinds)}
              />
            )}
          </>
        )}
      />
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
        {showWays && (
          <WaysOverview now={waysView.now} ways={waysView.ways} onAction={onWayAction} />
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

        <SettingsGroup heading="Add a phone" data-testid="devices-add-group">
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
            error={nameError ?? undefined}
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
    </SectionCard>
  );
}
