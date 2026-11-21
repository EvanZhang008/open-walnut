/**
 * Which devices each Phones & Cloud tab lists (2026-11-18, the user: "each section
 * should have its own paired device or connected device"). Pure, so the rules are
 * unit-tested (tests/web/device-scope.test.ts) apart from the React list.
 *
 * What the records say: one pairing is one token. The box it was paired on copies
 * the token's hash to the other box (core/device-adoption.ts), so a phone usually
 * has a record on this Mac (`lan`: it reaches this Mac directly, over Wi-Fi or
 * Tailscale) and one on the companion (`cloud`). Removing either removes both, so
 * a Remove is always the whole phone, whichever tab it is pressed on.
 *
 *   cloud      phones and Macs with a record on the companion, and this Mac's own link
 *   tailscale  phones with a record on this Mac (Tailscale reaches this Mac's own pairing)
 *   wifi       phones with a record on this Mac (on the same Wi-Fi they reach it directly), and
 *              browsers signed in with a code, so one signed in here is signed out here too
 *   browser    browsers and the Walnut extension, signed in with a code from that tab
 *   all        phones, browsers, the extension and other Macs, each row tagged with the ways it uses
 *   advanced   what is no phone and no browser (simulators; Settings > Advanced), with this Mac's own link
 */
import type { DeviceEntry } from './devices-reply';
import type { PairTargetKind } from './usePairDevice';

export type DeviceScope = 'all' | 'cloud' | 'tailscale' | 'browser' | 'wifi' | 'advanced';

/** One row per device name, with the boxes that hold a record of it. */
export type DeviceRow = DeviceEntry & { kinds: PairTargetKind[] };

/**
 * ONE row per physical device. The same phone is usually paired to both this Mac
 * and the cloud, and listing each credential separately showed the same name
 * twice. This Mac's own cloud record (`self`) is never merged with a phone that
 * happens to share its name: it is its own row.
 */
export function mergeDeviceRows(devices: readonly DeviceEntry[], cloudDevices: readonly DeviceEntry[]): DeviceRow[] {
  const byName = new Map<string, DeviceRow>();
  const add = (d: DeviceEntry, kind: PairTargetKind) => {
    const existing = byName.get(d.name);
    if (existing) {
      if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
      // The most recent activity across both records.
      if (d.lastUsedAt && (!existing.lastUsedAt || d.lastUsedAt > existing.lastUsedAt)) existing.lastUsedAt = d.lastUsedAt;
      if (!existing.info && d.info) existing.info = d.info;
      return;
    }
    byName.set(d.name, { ...d, kinds: [kind] });
  };
  devices.forEach((d) => add(d, 'lan'));
  cloudDevices.forEach((d) => { if (d.role !== 'self') add(d, 'cloud'); });
  // Real phones first: the row the user came for never sits under a sync credential.
  const rank = (r?: string) => (r === 'phone' || !r ? 0 : r === 'mac' ? 1 : r === 'simulator' ? 2 : 3);
  return [...byName.values()].sort((a, b) => rank(a.role) - rank(b.role));
}

const roleOf = (r: DeviceRow) => r.role ?? 'phone';

/** A browser signed in with a code (the server names it `browser-` and six hex), not the Walnut extension. */
export const SIGNED_IN_BROWSER = /^browser-[0-9a-f]{6}$/;

/** The rows a tab lists. Simulators show only in Settings > Advanced. */
export function rowsForScope(rows: readonly DeviceRow[], scope: DeviceScope): DeviceRow[] {
  switch (scope) {
    case 'all': return rows.filter((r) => ['phone', 'browser', 'mac'].includes(roleOf(r)));
    case 'advanced': return rows.filter((r) => !['phone', 'browser', 'mac'].includes(roleOf(r)));
    case 'cloud': return rows.filter((r) => r.kinds.includes('cloud') && (roleOf(r) === 'phone' || roleOf(r) === 'mac'));
    case 'tailscale': return rows.filter((r) => r.kinds.includes('lan') && roleOf(r) === 'phone');
    case 'wifi': return rows.filter((r) => (r.kinds.includes('lan') && roleOf(r) === 'phone') || (roleOf(r) === 'browser' && SIGNED_IN_BROWSER.test(r.name)));
    case 'browser': return rows.filter((r) => roleOf(r) === 'browser');
  }
}

/** A way a device uses, named as its tab is (a browser's way is its own group, so it has none). */
export type WayTag = 'Cloud companion' | 'Same Wi-Fi';

/**
 * The ways a row reaches Walnut, by the tab names: a record on the companion is the
 * cloud companion; one on this Mac is Wi-Fi. A record on this Mac also works over
 * Tailscale, but only when the phone runs Tailscale too, which nothing here can
 * tell, so no row is tagged Tailscale (a tag would be a guess). A tab leaves out
 * its own way (every row there uses it).
 *
 * On the companion's own console (`replica`) the list's `devices` are the
 * companion's records, so a `lan` record there is the cloud companion way.
 */
export function wayTags(row: DeviceRow, opts: { scope: DeviceScope; replica?: boolean }): WayTag[] {
  if (roleOf(row) === 'browser') return [];
  const own: WayTag | null = opts.scope === 'cloud' ? 'Cloud companion' : opts.scope === 'wifi' ? 'Same Wi-Fi' : null;
  return waysOf(row, opts).filter((t) => t !== own);
}

function waysOf(row: DeviceRow, opts: { replica?: boolean }): WayTag[] {
  if (opts.replica) return ['Cloud companion'];
  const tags: WayTag[] = [];
  if (row.kinds.includes('cloud')) tags.push('Cloud companion');
  if (row.kinds.includes('lan')) tags.push('Same Wi-Fi');
  return tags;
}

/**
 * The address a tab's pairing QR carries: its own way's (pairing lives in each way's tab,
 * 2026-11-18; Wi-Fi got its own tab 2026-11-21, the user: "Put it in closest so people know").
 * All devices pairs only on the companion's own console, through its own address (it has no
 * other tab that pairs), and never for a browser signed in with a code: the server refuses it
 * every code.
 */
export function pairTargetForScope(
  scope: DeviceScope,
  offered: readonly PairTargetKind[] = [],
  opts: { replica?: boolean; deviceCaller?: boolean } = {},
): PairTargetKind | null {
  if (opts.deviceCaller) return null;
  if (scope === 'cloud') return 'cloud';
  if (scope === 'tailscale') return 'tailnet';
  if (scope === 'wifi') return opts.replica ? null : 'lan';
  if (scope === 'all' && opts.replica) return offered.includes('cloud') ? 'cloud' : null;
  return null;
}

/**
 * What Remove says before it removes a phone: every way it uses, named. One pairing
 * works on every way and removing it on one box removes its copy on the other, so
 * it never removes only one way (the phone app says Disconnect for "stop
 * connecting, keep the login").
 */
export function removePhoneWarning(row: DeviceRow, opts: { replica?: boolean }, shownName = row.name): string {
  const ways = waysOf(row, opts).map((t) => (t === 'Cloud companion' ? 'the cloud companion' : 'this Mac directly (Wi-Fi, or Tailscale)'))
  const named = ways.length === 0 ? '' : `: ${ways.join(' and ')}`
  return `Removing ${shownName} signs it out of this Walnut on every way it uses${named}. `
    + 'Its saved login stops working; to use it again, scan a new QR code.';
}
