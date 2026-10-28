/**
 * Settings › Phones & Cloud, top of the pane: how the phone reaches Walnut right
 * now, and the three ways it can reach it away from home (cloud companion,
 * Tailscale, a browser link through a tunnel), each with what it is, when to use
 * it, whether it is on, and how to turn it on. Pure, so every state is
 * unit-tested (tests/web/devices-ways-model.test.ts) apart from the React pane.
 *
 * The server knows which credential a phone last used (this Mac's own, or the
 * cloud companion's) and when, not which network it came over: a use of this
 * Mac's credential is "directly" (Wi-Fi, or Tailscale while it runs).
 */
import { timeAgo } from '@/utils/time';
import type { ExposeStatus } from './browser-access-status';
import type { PairTargetKind } from './usePairDevice';

export type WayId = 'cloud' | 'tailscale' | 'browser';
export type WayDot = 'on' | 'off' | 'warn';

/** One credential of a phone: this Mac's (`lan`) or the companion's (`cloud`). */
export interface PhoneUse {
  name: string;
  via: 'lan' | 'cloud';
  lastUsedAt?: string;
}

export interface WaysInput {
  listState: 'loading' | 'ready' | 'failed';
  /** Every phone credential, both halves; simulators, Macs and browsers left out. */
  phoneUses: readonly PhoneUse[];
  targets: readonly { kind: PairTargetKind; origin: string }[];
  cloudError: string | null;
  cloudUnpaired: boolean;
  /** A companion exists, but this caller is not this Mac, so its half is not shown here. */
  cloudWithheld?: boolean;
  /** GET /api/devices `tailscale`; absent from an older server. */
  tailscale?: { installed: boolean; running: boolean };
  /** GET /api/expose `status`; null while it loads, 'failed' when it could not be read. */
  expose: ExposeStatus | null | 'failed';
  now?: number;
}

export interface NowLine {
  tone: 'ok' | 'warn' | 'none';
  title: string;
  /** "iphone → Cloud companion → This Mac", when a phone has connected. */
  hops?: string[];
  detail: string;
}

export interface Way {
  id: WayId;
  title: string;
  what: string;
  useWhen: string;
  dot: WayDot;
  /** Short state word on the card's corner. */
  tag: string;
  status: string;
  inUse: boolean;
  /** The card's button: open this way's settings below, or set it up. */
  action: { label: string; primary: boolean };
}

export const SAME_WIFI_LINE = 'At home on the same Wi-Fi as this Mac, the app connects directly. Nothing to set up.';

const host = (origin: string) => origin.replace(/^https?:\/\//, '').replace(/\/+$/, '');

/** The phone credential used most recently, if any was ever used. */
export function latestUse(uses: readonly PhoneUse[]): PhoneUse | null {
  let best: PhoneUse | null = null;
  for (const u of uses) {
    if (!u.lastUsedAt) continue;
    if (!best || u.lastUsedAt > best.lastUsedAt!) best = u;
  }
  return best;
}

function cloudWay(i: WaysInput, inUse: boolean): Way {
  const target = i.targets.find((t) => t.kind === 'cloud');
  const base = {
    id: 'cloud' as const,
    title: 'Cloud companion',
    what: 'A small server of yours in the cloud. Your phone talks to it, and it talks to this Mac.',
    useWhen: 'You want Walnut on the go, on any network, even while this Mac sleeps.',
    inUse,
  };
  if (i.cloudError) {
    return { ...base, dot: 'warn', tag: 'Not answering', status: "Set up, but it isn't answering right now.", action: { label: 'Settings', primary: false } };
  }
  if (i.cloudWithheld) {
    return { ...base, dot: 'on', tag: 'On', status: 'Set up; its details show only on the Mac itself.', action: { label: 'Settings', primary: false } };
  }
  if (target) {
    return { ...base, dot: 'on', tag: inUse ? 'In use' : 'On', status: `On at ${host(target.origin)}`, action: { label: 'Settings', primary: false } };
  }
  if (i.cloudUnpaired) {
    return { ...base, dot: 'off', tag: 'Off', status: 'This Mac is no longer paired with it.', action: { label: 'Settings', primary: false } };
  }
  return { ...base, dot: 'off', tag: 'Off', status: 'Not set up.', action: { label: 'Set up', primary: true } };
}

function tailscaleWay(i: WaysInput): Way {
  const base = {
    id: 'tailscale' as const,
    title: 'Tailscale',
    what: 'A private network between this Mac and your phone. The phone talks to this Mac directly.',
    useWhen: 'You want a direct link from anywhere; this Mac must be awake.',
    inUse: false,
  };
  const ts = i.tailscale;
  // The server leaves the field out until its first probe answers (and an older one always).
  if (!ts) return { ...base, dot: 'off', tag: '', status: 'Checking...', action: { label: 'Settings', primary: false } };
  if (ts.running) {
    // Running without a tailnet address: the phone cannot come in over it yet.
    if (!i.targets.some((t) => t.kind === 'tailnet')) {
      return { ...base, dot: 'warn', tag: 'Not ready', status: 'Running, but this Mac has no tailnet address yet.', action: { label: 'Settings', primary: false } };
    }
    return { ...base, dot: 'on', tag: 'On', status: 'On; this Mac is on your tailnet.', action: { label: 'Settings', primary: false } };
  }
  if (ts.installed) {
    return { ...base, dot: 'warn', tag: 'Off', status: 'Installed on this Mac, not running.', action: { label: 'Set up Tailscale', primary: true } };
  }
  return { ...base, dot: 'off', tag: 'Off', status: 'Not installed on this Mac.', action: { label: 'Set up Tailscale', primary: true } };
}

function browserWay(i: WaysInput): Way {
  const base = {
    id: 'browser' as const,
    title: 'Browser link',
    what: 'An HTTPS address that opens Walnut in any browser after you sign in.',
    useWhen: 'You are on a computer or phone without the Walnut app.',
    inUse: false,
  };
  const s = i.expose;
  const settings = { label: 'Settings', primary: false };
  if (s === null) return { ...base, dot: 'off', tag: '', status: 'Checking...', action: settings };
  if (s === 'failed') return { ...base, dot: 'warn', tag: '', status: "Couldn't read the tunnel's state.", action: settings };
  const through = s.providerTitle ? ` through ${s.providerTitle}` : '';
  const where = s.runsOn ? `, runs on ${s.runsOn.label}` : '';
  switch (s.state) {
    case 'connected':
      return { ...base, dot: 'on', tag: 'On', status: `Connected${through}${where}.`, action: settings };
    case 'starting':
    case 'retrying':
      return { ...base, dot: 'warn', tag: 'Connecting', status: `Connecting${through}...`, action: settings };
    case 'needs-sign-in':
      return { ...base, dot: 'warn', tag: 'Needs you', status: `Waiting for you to sign in${through}.`, action: settings };
    case 'missing':
    case 'unavailable':
      return { ...base, dot: 'warn', tag: 'Off', status: 'Its tunnel tool is missing on this machine.', action: settings };
    case 'off':
    default:
      return { ...base, dot: 'off', tag: 'Off', status: s.enabled ? 'Off.' : 'Not turned on.', action: { label: 'Set up', primary: true } };
  }
}

function nowLine(i: WaysInput, cloud: Way, tailscale: Way): NowLine {
  if (i.listState === 'loading') return { tone: 'none', title: 'Checking how your phone reaches Walnut...', detail: '' };
  if (i.listState === 'failed') return { tone: 'warn', title: "Couldn't load your phones", detail: 'The list of paired phones did not load; reopen this page to try again.' };
  if (i.phoneUses.length === 0) {
    return { tone: 'none', title: 'No phone is paired yet', detail: 'Add one below: scan a QR code with the Walnut app.' };
  }
  // The companion's half of the list is missing (it did not answer, or it is shown
  // only on the Mac itself): whatever this Mac saw last may not be the newest use.
  if (i.cloudError) {
    return {
      tone: 'warn',
      title: "Can't tell how your phone reaches Walnut right now",
      detail: "The cloud companion isn't answering, so the phones it knows are missing here. At home on the same Wi-Fi the app still reaches this Mac directly.",
    };
  }
  const last = latestUse(i.phoneUses);
  if (!last) {
    if (i.cloudWithheld) return { tone: 'none', title: 'Your phones are listed on the Mac itself', detail: 'Open these settings on the Mac to see how each phone connects.' };
    return { tone: 'none', title: "Your phone hasn't connected yet", detail: 'Open the Walnut app on it once after pairing.' };
  }
  const seen = timeAgo(last.lastUsedAt!, { long: true, now: i.now });
  if (last.via === 'cloud') {
    return {
      tone: 'ok',
      title: `${last.name} reaches Walnut through the cloud companion`,
      hops: [last.name, 'Cloud companion', 'This Mac'],
      detail: `Last seen ${seen}. Works anywhere, even while this Mac sleeps.`,
    };
  }
  const how = tailscale.dot === 'on' ? 'on the same Wi-Fi or over Tailscale' : 'on the same Wi-Fi';
  const away = cloud.dot === 'on' || tailscale.dot === 'on';
  // The companion's phones are not shown here, so a newer use through it may exist.
  if (i.cloudWithheld) {
    return { tone: 'ok', title: `${last.name} reached this Mac directly`, hops: [last.name, 'This Mac'], detail: `Last seen here ${seen}. Uses through the cloud companion show only on the Mac itself.` };
  }
  return {
    tone: away ? 'ok' : 'warn',
    title: `${last.name} reaches this Mac directly`,
    hops: [last.name, 'This Mac'],
    detail: away
      ? `Last seen ${seen}, ${how}.`
      : `Last seen ${seen}, ${how}. Away from home it can't reach Walnut until the cloud companion or Tailscale is on.`,
  };
}

export function deriveWays(i: WaysInput): { now: NowLine; ways: Way[] } {
  const last = latestUse(i.phoneUses);
  const cloud = cloudWay(i, last?.via === 'cloud' && !i.cloudError);
  const tailscale = tailscaleWay(i);
  return { now: nowLine(i, cloud, tailscale), ways: [cloud, tailscale, browserWay(i)] };
}
