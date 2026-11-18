/**
 * Pairing a new phone on a Phones & Cloud tab (DeviceList.tsx): the name, and Pair.
 * A way's own tab pairs through its own address ("Pair a phone this way"); All
 * devices offers the address picker ("Add a phone") and a phone browser's sign-in link.
 *
 * The picker only chooses which address goes in the QR. A phone paired through
 * any address learns the other addresses by itself, so pick the one the phone
 * can reach right now: a Wi-Fi QR scanned over cellular never connects at all.
 */
import { useRef, useState } from 'react';
import { SettingsGroup, SettingsRow, SettingsNotice } from '../../SettingsSection';
import { SettingsButton } from '../../inputs/SettingsButton';
import { SegmentedControl } from '../../inputs/SegmentedControl';
import { WAY_PANES } from '../../settings-way-panes';
import { deviceNameForServer } from '../device-name';
import { useDraft } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';
import { MicInput, type BoxMicHandle } from '@/components/common/BoxMic';
import { useSendAfterDictation, dictationWaitProps } from '@/hooks/useSendAfterDictation';
import type { PairingTarget, PairTargetKind } from './usePairDevice';
import type { DeviceScope } from './device-scope';

/** What a tab's Pair row says: where its code points the phone. */
const PAIR_HELP: Partial<Record<PairTargetKind, string>> = {
  cloud: 'The QR code points the phone at your companion, so it works away from home and while this Mac sleeps. At home it also reaches this Mac over Wi-Fi.',
  tailnet: "The QR code points the phone at this Mac's Tailscale address, so it works wherever both run Tailscale, and over Wi-Fi at home.",
};

/** Why a tab cannot pair its way right now. */
const PAIR_UNOFFERED: Partial<Record<PairTargetKind, string>> = {
  cloud: "The companion's address isn't available right now, so a code can't point at it yet. Phones paired with this Mac can still use it once it is back.",
  tailnet: "Set up Tailscale on this Mac first (step 1 above); then the code can point at this Mac's Tailscale address.",
};

interface Props {
  scope: DeviceScope;
  /** This tab's own address, or 'pick' for the picker (All devices). */
  fixedTarget: PairTargetKind | 'pick';
  targets: readonly PairingTarget[];
  /** The picker's pick (All devices). */
  target: PairTargetKind;
  setTarget: (k: PairTargetKind) => void;
  listState: 'loading' | 'ready' | 'failed';
  busy: boolean;
  /** A browser signed in with a code: no link to sign in another one. */
  isDevice: boolean;
  /** Make the code for this name (it opens in the list's dialog); true when it was made. */
  onPair: (name: string, target: PairTargetKind | undefined) => Promise<boolean>;
}

export function PairPhoneGroup({ scope, fixedTarget, targets, target, setTarget, listState, busy, isDevice, onPair }: Props) {
  const pick = fixedTarget === 'pick';
  // A device name typed and not paired yet survives leaving the pane, one per tab; a pairing ends it.
  const nameDraft = useDraft(draftKey('pair-device-name', scope === 'all' ? 'new' : scope));
  const { text: newName, setText: setNewName } = nameDraft;
  const [nameError, setNameError] = useState<string | null>(null);
  const nameMic = useRef<BoxMicHandle | null>(null);
  const chosenKind = pick ? target : fixedTarget;
  const offered = pick || targets.some((t) => t.kind === fixedTarget);

  const addDevice = async () => {
    if (!newName.trim() || busy || !offered) return;
    // "My iPhone" is the natural shape; the server wants an id (N3-03).
    const name = deviceNameForServer(newName);
    if (!name) { setNameError('Use at least one letter or digit in the name.'); return; }
    setNameError(null);
    nameMic.current?.clear();
    // Only send an explicit target when one was actually offered: otherwise the
    // server picks (a token-only QR).
    const made = await onPair(name, targets.some((t) => t.kind === chosenKind) ? chosenKind : undefined);
    if (made) nameDraft.clear(nameDraft.key);
  };
  // Pair (the button, or Enter in the name) waits for a name still being dictated.
  const addGate = useSendAfterDictation([nameMic], () => void addDevice());

  const activeTarget = targets.find((t) => t.kind === target);
  const showPicker = pick && targets.length > 1;
  const targetHelp = activeTarget?.kind === 'cloud'
    ? 'Works from anywhere, including cellular; the token is created on your cloud companion.'
    : activeTarget?.kind === 'tailnet'
      ? 'Works anywhere the phone is on the same tailnet as this machine, including cellular.'
      : activeTarget
        ? <>Works only while the phone is on the same <span className="settings-nowrap">Wi-Fi</span> as this Mac.</>
        : undefined;
  const nameHelp = !pick ? PAIR_HELP[fixedTarget]
    : targets.length === 1 && activeTarget?.kind === 'lan'
      ? <>Pair a phone by scanning a QR code; this one works only on the same <span className="settings-nowrap">Wi-Fi</span> as this Mac.</>
      : targets.length === 1 && activeTarget?.kind === 'tailnet'
        ? 'Pair a phone by scanning a QR code; this one works anywhere the phone is on the same tailnet as this machine.'
        : 'Pair a phone by scanning a QR code with the Walnut iOS app.';

  return (
    <SettingsGroup heading={pick ? 'Add a phone' : 'Pair a phone this way'} data-testid={pick ? 'devices-add-group' : `way-pair-${scope}`}>
      {/* The other way in: a phone's browser, from anywhere, with a sign-in link (the tunnel's tab). */}
      {pick && !isDevice && (
        <SettingsRow
          label="Phone browser"
          help="Open Walnut in a phone's browser from anywhere, signed in with a link."
          data-testid="devices-add-browser-row"
          control={(
            <a className="settings-button settings-button-default" href={`#${WAY_PANES.browser}`} data-testid="devices-add-tunnel-link">
              <span className="settings-button-stack"><span className="settings-button-label">Get a sign-in link</span></span>
            </a>
          )}
        />
      )}
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
      {pick && listState === 'ready' && targets.length === 0 && (
        <SettingsNotice kind="info">
          No address for this machine can be detected, so the QR carries only the token and you type the
          server address in the app; for one-tap pairing from anywhere, <a href="#cloud">set up a cloud companion</a>.
        </SettingsNotice>
      )}
      {!pick && !offered && listState === 'ready' && <SettingsNotice kind="info">{PAIR_UNOFFERED[fixedTarget]}</SettingsNotice>}
      <SettingsRow
        label="Device name"
        htmlFor="devices-new-name"
        wide
        help={nameHelp}
        error={nameError ?? undefined}
        control={
          <span className="settings-addons-inline devices-add-row">
            <MicInput fieldClassName="settings-mic-field settings-mic-field-short"
              id="devices-new-name"
              type="text"
              data-draft-key={nameDraft.key ?? undefined}
              className="settings-input settings-input--short"
              value={newName}
              placeholder="My iPhone"
              setText={(text) => { setNewName(text); setNameError(null); }}
              micRef={nameMic}
              onEnter={addGate.send}
            />
            <SettingsButton
              variant="primary"
              disabled={!offered || (!newName.trim() && !addGate.micBusy && !addGate.waiting)}
              title={!offered || newName.trim() ? undefined : 'Name the device first.'}
              busy={busy}
              busyLabel="Pairing..."
              onClick={addGate.send}
              data-testid="devices-pair-new"
              {...dictationWaitProps(addGate)}
            >
              {pick ? 'Pair new device' : 'Pair phone'}
            </SettingsButton>
          </span>
        }
      />
    </SettingsGroup>
  );
}
