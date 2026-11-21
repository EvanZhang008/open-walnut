/**
 * Pairing a new phone on a Phones & Cloud tab (DeviceList.tsx): the name, and Pair. Each way's
 * own tab pairs through its own address ("Pair the Walnut app this way"); All devices pairs on this
 * Wi-Fi only when no way tab can (device-scope.ts pairTargetForScope).
 *
 * A phone paired once works over every way it can reach; the QR only picks the address it
 * tries first, so a Wi-Fi QR scanned over cellular never connects at all.
 */
import { useRef, useState } from 'react';
import { SettingsGroup, SettingsRow, SettingsNotice } from '../../SettingsSection';
import { SettingsButton } from '../../inputs/SettingsButton';
import { deviceNameForServer } from '../device-name';
import { useDraft } from '@/hooks/useDraft';
import { draftKey } from '@/utils/drafts';
import { MicInput, type BoxMicHandle } from '@/components/common/BoxMic';
import { useSendAfterDictation, dictationWaitProps } from '@/hooks/useSendAfterDictation';
import type { PairingTarget, PairTargetKind } from './usePairDevice';
import type { DeviceScope } from './device-scope';

/** What a tab's Pair row says: where its code points the phone. */
const PAIR_HELP: Record<PairTargetKind, string> = {
  cloud: 'The QR points the phone at your companion: it works away from home and while this Mac sleeps.',
  tailnet: "The QR code points the phone at this Mac's Tailscale address: it works wherever both run Tailscale, so the phone needs Tailscale on to connect the first time.",
  lan: "The app tries this Mac's Wi-Fi address first; the same pairing works over the companion or Tailscale too.",
};

/** On the companion's own console its address is this server's. */
const PAIR_HELP_HERE = 'The QR code points the phone at this server, so it works from anywhere.';

/** Why a tab cannot pair its way right now (Wi-Fi always can: the QR then carries only the token). */
const PAIR_UNOFFERED: Partial<Record<PairTargetKind, string>> = {
  cloud: "The companion's address isn't available right now, so a code can't point at it yet. Phones paired with this Mac can still use it once it is back.",
  lan: "No address for this Mac can be detected, so the QR carries only the token and you type the server address in the app.",
};

interface Props {
  scope: DeviceScope;
  /** The address this tab's code carries. */
  fixedTarget: PairTargetKind;
  targets: readonly PairingTarget[];
  listState: 'loading' | 'ready' | 'failed';
  busy: boolean;
  /** Make the code for this name (it opens in the list's dialog); true when it was made. */
  onPair: (name: string, target: PairTargetKind | undefined) => Promise<boolean>;
}

export function PairPhoneGroup({ scope, fixedTarget, targets, listState, busy, onPair }: Props) {
  // A device name typed and not paired yet survives leaving the pane, one per tab; a pairing ends it.
  const nameDraft = useDraft(draftKey('pair-device-name', scope === 'all' ? 'new' : scope));
  const { text: newName, setText: setNewName } = nameDraft;
  const [nameError, setNameError] = useState<string | null>(null);
  const nameMic = useRef<BoxMicHandle | null>(null);
  const hasTarget = targets.some((t) => t.kind === fixedTarget);
  // Wi-Fi pairs without a detected address too (a token-only QR); the other ways need theirs.
  const offered = hasTarget || fixedTarget === 'lan';

  const addDevice = async () => {
    if (!newName.trim() || busy || !offered) return;
    // "My iPhone" is the natural shape; the server wants an id (N3-03).
    const name = deviceNameForServer(newName);
    if (!name) { setNameError('Use at least one letter or digit in the name.'); return; }
    setNameError(null);
    nameMic.current?.clear();
    // Only send an explicit target when one was actually offered: otherwise the server picks (a token-only QR).
    const made = await onPair(name, hasTarget ? fixedTarget : undefined);
    if (made) nameDraft.clear(nameDraft.key);
  };
  // Pair (the button, or Enter in the name) waits for a name still being dictated.
  const addGate = useSendAfterDictation([nameMic], () => void addDevice());

  // Tailscale not set up yet: its steps above say what to do, so no pairing box waits here.
  if (fixedTarget === 'tailnet' && !hasTarget && listState === 'ready') return null;
  return (
    <SettingsGroup
      heading={fixedTarget === 'lan' ? 'Walnut app: pair a phone over Wi-Fi' : 'Walnut app: pair a new phone'}
      id={`way-pair-${scope}`}
      data-testid={`way-pair-${scope}`}
    >
      {!hasTarget && listState === 'ready' && <SettingsNotice kind="info">{PAIR_UNOFFERED[fixedTarget]}</SettingsNotice>}
      {/* A way that cannot pair yet shows only what is missing, not a form that cannot be used. */}
      {(offered || listState !== 'ready') && <SettingsRow
        label="Device name"
        htmlFor="devices-new-name"
        wide
        help={`Name the phone, then get its QR code. ${scope === 'all' && fixedTarget === 'cloud' ? PAIR_HELP_HERE : PAIR_HELP[fixedTarget]}`}
        error={nameError ?? undefined}
        control={
          <span className="settings-addons-inline devices-add-row">
            <MicInput fieldClassName="settings-mic-field settings-mic-field-short"
              id="devices-new-name"
              type="text"
              data-draft-key={nameDraft.key ?? undefined}
              className="settings-input settings-input--short"
              value={newName}
              placeholder="Name it, e.g. My iPhone"
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
              Get QR for a new phone
            </SettingsButton>
          </span>
        }
      />}
    </SettingsGroup>
  );
}
