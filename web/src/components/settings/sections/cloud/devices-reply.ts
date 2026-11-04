/**
 * One GET /api/devices reply folded into what Phones & Cloud shows. A value
 * shown stays shown until a real one replaces it (the user, 2026-11-04: "cache
 * should cache for long time until the real data come"): a reply whose cloud
 * half failed keeps the phones listed before (the server's kept list when it
 * has one, else the page's own), and a reply without Tailscale's summary (the
 * server's probe still cold) keeps the summary known before. The error is shown
 * beside the kept list, never instead of it.
 */
import type { PairingTarget } from './usePairDevice';

/** Self-reported hardware identity, absent until the phone checks in once. */
export interface DeviceSelfInfo {
  model?: string;
  os?: string;
  deviceName?: string;
  appVersion?: string;
  reportedAt?: string;
}

export interface DeviceEntry {
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  /** What this credential actually is: not everything in the list is a phone. */
  role?: 'phone' | 'simulator' | 'mac' | 'self' | 'browser';
  info?: DeviceSelfInfo;
}

export type TailscaleBrief = { installed: boolean; running: boolean };

/** GET /api/devices. `cloudStale`/`cloudDevicesAt`/`tailscaleStale`/`tailscaleAt` come from newer servers only. */
export interface DevicesListResponse {
  devices: DeviceEntry[];
  cloudDevices?: DeviceEntry[];
  targets?: PairingTarget[];
  tailscale?: TailscaleBrief;
  tailscaleStale?: boolean;
  tailscaleAt?: string;
  cloudError?: string;
  /** `cloudDevices` is the companion's last good list, read at `cloudDevicesAt`. */
  cloudStale?: boolean;
  cloudDevicesAt?: string;
  cloudUnpaired?: { origin: string };
  cloudWithheld?: string;
}

export interface DevicesView {
  devices: DeviceEntry[];
  cloudDevices: DeviceEntry[];
  /** When the cloud list shown was read (ISO); null before any was. */
  cloudReadAt: string | null;
  /** The cloud list shown is older than this reply (its read failed). */
  cloudStale: boolean;
  targets: PairingTarget[];
  tailscale?: TailscaleBrief;
  /** The summary shown is an earlier probe's: ask again for a fresh one. */
  tailscaleStale: boolean;
  /** When the summary shown was probed (ISO); null when not known. A copy kept by an older page has none. */
  tailscaleAt?: string | null;
  cloudError: string | null;
  cloudUnpaired: boolean;
  cloudWithheld: boolean;
}

export const EMPTY_DEVICES_VIEW: DevicesView = {
  devices: [], cloudDevices: [], cloudReadAt: null, cloudStale: false, targets: [],
  tailscale: undefined, tailscaleStale: false, tailscaleAt: null, cloudError: null, cloudUnpaired: false, cloudWithheld: false,
};

function cloudHalf(prev: DevicesView, res: DevicesListResponse, now: string): Pick<DevicesView, 'cloudDevices' | 'cloudReadAt' | 'cloudStale'> {
  // Gone on purpose (unpaired, or withheld from this caller): nothing to keep.
  if (res.cloudUnpaired || res.cloudWithheld) return { cloudDevices: res.cloudDevices ?? [], cloudReadAt: null, cloudStale: false };
  if (!res.cloudError) return { cloudDevices: res.cloudDevices ?? [], cloudReadAt: now, cloudStale: false };
  // The read failed. A newer server sends its kept list; an older one (or one with
  // none kept) sends [] and the page keeps its own.
  if (res.cloudStale && res.cloudDevices) {
    return { cloudDevices: res.cloudDevices, cloudReadAt: res.cloudDevicesAt ?? prev.cloudReadAt, cloudStale: true };
  }
  if (res.cloudDevices?.length) return { cloudDevices: res.cloudDevices, cloudReadAt: prev.cloudReadAt, cloudStale: true };
  return { cloudDevices: prev.cloudDevices, cloudReadAt: prev.cloudReadAt, cloudStale: prev.cloudDevices.length > 0 };
}

/** The view after `res`. `now` (ISO) stamps a cloud list read fresh. Pure. */
export function mergeDevicesReply(prev: DevicesView, res: DevicesListResponse, now: string): DevicesView {
  const tailscale = res.tailscale ?? prev.tailscale;
  return {
    devices: res.devices,
    ...cloudHalf(prev, res, now),
    targets: res.targets ?? [],
    tailscale,
    tailscaleStale: res.tailscale ? res.tailscaleStale === true : !!tailscale,
    // Fresh: read now. The server's kept one: its own time. Kept here: the time it had.
    tailscaleAt: res.tailscale ? (res.tailscaleStale ? res.tailscaleAt ?? null : now) : prev.tailscaleAt ?? null,
    cloudError: res.cloudError ?? null,
    cloudUnpaired: Boolean(res.cloudUnpaired),
    cloudWithheld: Boolean(res.cloudWithheld),
  };
}

/** A view read back from storage is shaped like one (an older page's copy, or garbage, is not). */
export function isDevicesView(v: unknown): v is DevicesView {
  const o = v as DevicesView;
  return !!o && typeof o === 'object' && Array.isArray(o.devices) && Array.isArray(o.cloudDevices) && Array.isArray(o.targets)
    && (o.cloudReadAt === null || typeof o.cloudReadAt === 'string') && typeof o.cloudStale === 'boolean'
    && typeof o.tailscaleStale === 'boolean' && (o.tailscaleAt == null || typeof o.tailscaleAt === 'string') && typeof o.cloudUnpaired === 'boolean' && typeof o.cloudWithheld === 'boolean'
    && (o.cloudError === null || typeof o.cloudError === 'string')
    && o.devices.every((d) => !!d && typeof d.name === 'string') && o.cloudDevices.every((d) => !!d && typeof d.name === 'string');
}

/** The cloud error as shown: with the age of the list kept beside it. */
export function cloudErrorLine(view: Pick<DevicesView, 'cloudError' | 'cloudStale' | 'cloudReadAt' | 'cloudDevices'>, ago: (iso: string) => string): string | null {
  if (!view.cloudError) return null;
  if (!view.cloudStale || !view.cloudReadAt || view.cloudDevices.length === 0) return view.cloudError;
  return `${view.cloudError} The phones below are as it listed them ${ago(view.cloudReadAt)}.`;
}
