/**
 * The words on Phones & Cloud's device rows and its pairing dialog (pure, so the
 * helpers are unit-tested apart from the pane; DevicesSection re-exports them).
 */
import { formatAbsoluteTime } from '../addons-format';
import type { DeviceEntry, DeviceSelfInfo } from './useDevicesData';
import type { PairTargetKind } from './usePairDevice';

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

export const ROLE_NOTE: Record<'simulator' | 'self' | 'browser', string> = {
  self: "This Mac's own pairing with the cloud companion. Cloud sync, your phones' way to this Mac, and the Cloud host run on it.",
  simulator: 'iOS Simulator on this computer (development).',
  browser: 'A browser you signed in with a code; removing it signs that browser out.',
};

/** Said before "Unpair this Mac" goes through: what stops working, and the way back. */
export const UNPAIR_SELF_WARNING =
  'Unpairing this Mac stops cloud sync, cuts your phones off from this Mac through the companion, and takes the Cloud host offline. Pairing it again needs a new token made on the companion.';

/** What the code in the dialog reaches, in the words the cards use. */
export function reachWords(kind?: PairTargetKind): string | undefined {
  if (kind === 'cloud') return 'Uses the cloud companion, so it works from anywhere.';
  if (kind === 'tailnet') return 'Uses Tailscale, so it works anywhere the phone is on your tailnet.';
  if (kind === 'lan') return 'Uses this Wi-Fi; the phone learns the other ways once it connects.';
  return undefined;
}
