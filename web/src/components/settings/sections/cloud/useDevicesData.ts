/**
 * What Phones & Cloud and its sub-pages read from the server: GET /api/devices
 * (every paired phone, browser and Mac, both halves, the pairing addresses and
 * Tailscale's summary) and, for the Browser link card, GET /api/expose. The main
 * entry and the Tailscale sub-page each mount their own copy; the list read is
 * shared while in flight (devices-list.ts).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet } from '@/api/client';
import { log } from '@/utils/log';
import { fetchDevicesList } from './devices-list';
import type { ExposeStatus } from './browser-access-status';
import type { PairingTarget, PairTargetKind } from './usePairDevice';

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

/** GET /api/devices (its `tailscale` summary is read by the card through its own endpoint). */
interface DevicesListResponse {
  devices: DeviceEntry[];
  cloudDevices?: DeviceEntry[];
  targets?: PairingTarget[];
  tailscale?: { installed: boolean; running: boolean };
  cloudError?: string;
  cloudUnpaired?: { origin: string };
  cloudWithheld?: string;
}

export interface DevicesData {
  devices: DeviceEntry[];
  cloudDevices: DeviceEntry[];
  targets: PairingTarget[];
  // Until the list answers, nothing is known: no "No phones" line and no "no address" notice
  // that then vanish and pull a deep-linked section below them upward (C74).
  listState: 'loading' | 'ready' | 'failed';
  tailscale?: { installed: boolean; running: boolean };
  /** The cloud half of the list failed to load (the reason, from the server). */
  cloudError: string | null;
  /** This Mac unpaired itself: the cloud half is gone on purpose. */
  cloudUnpaired: boolean;
  cloudWithheld: boolean;
  refresh: () => Promise<void>;
}

/**
 * The device list. `onTargets` runs with each new list of pairing addresses (the
 * main entry keeps its picker on an address still offered).
 */
export function useDevicesData(opts: { replica: boolean; onTargets?: (kinds: PairTargetKind[]) => void }): DevicesData {
  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [cloudDevices, setCloudDevices] = useState<DeviceEntry[]>([]);
  const [targets, setTargets] = useState<PairingTarget[]>([]);
  const [listState, setListState] = useState<DevicesData['listState']>('loading');
  const [tailscale, setTailscale] = useState<DevicesData['tailscale']>(undefined);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [cloudUnpaired, setCloudUnpaired] = useState(false);
  const [cloudWithheld, setCloudWithheld] = useState(false);
  const onTargets = useRef(opts.onTargets);
  onTargets.current = opts.onTargets;

  // Reads can land out of order (a pairing's read can beat the pane's first one):
  // only the newest read writes the list.
  const readSeq = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++readSeq.current;
    try {
      const res = await fetchDevicesList<DevicesListResponse>();
      if (seq !== readSeq.current) return;
      setDevices(res.devices);
      setCloudDevices(res.cloudDevices ?? []);
      setCloudError(res.cloudError ?? null);
      setCloudUnpaired(Boolean(res.cloudUnpaired));
      setTailscale(res.tailscale);
      setCloudWithheld(Boolean(res.cloudWithheld));
      const list = res.targets ?? [];
      setTargets(list);
      onTargets.current?.(list.map((t) => t.kind));
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

  // The server leaves Tailscale out of the list until its first probe answers: ask
  // again a few times, so the card does not sit on "Checking..." (an older server never says).
  const tailscaleAsks = useRef(0);
  const { replica } = opts;
  useEffect(() => {
    if (replica || listState !== 'ready' || tailscale || tailscaleAsks.current >= 3) return;
    const t = setTimeout(() => { tailscaleAsks.current += 1; void refresh(); }, 4_000);
    return () => clearTimeout(t);
  }, [replica, listState, tailscale, refresh]);

  return { devices, cloudDevices, targets, listState, tailscale, cloudError, cloudUnpaired, cloudWithheld, refresh };
}

/**
 * The browser link card's state (GET /api/expose): every 30s, every 5s while it
 * moves, never while the tab is hidden. A companion has none (`off`).
 */
export function useExposeStatus(off: boolean): ExposeStatus | null | 'failed' {
  const [expose, setExpose] = useState<ExposeStatus | null | 'failed'>(null);
  const moving = expose !== null && expose !== 'failed' && ['starting', 'retrying', 'needs-sign-in'].includes(expose.state);
  useEffect(() => {
    if (off) return;
    let live = true;
    const read = () => {
      if (document.hidden) return;
      apiGet<{ status: ExposeStatus }>('/api/expose')
        .then((res) => { if (live) setExpose(res.status); })
        .catch((err) => {
          log.warn('settings', 'expose state read failed', { error: String(err) });
          if (live) setExpose((prev) => (prev && prev !== 'failed' ? prev : 'failed'));
        });
    };
    read();
    const timer = setInterval(read, moving ? 5_000 : 30_000);
    return () => { live = false; clearInterval(timer); };
  }, [off, moving]);
  return expose;
}

/**
 * "Use the tailnet address" on the Tailscale sub-page: the pairing picker lives on
 * the main entry, so the choice waits here until that pane mounts and takes it.
 */
let requestedTarget: PairTargetKind | null = null;
export function requestPairTarget(kind: PairTargetKind): void { requestedTarget = kind; }
/** Read in a state initializer (a render may run twice); the pane clears it once mounted. */
export function peekRequestedPairTarget(): PairTargetKind | null { return requestedTarget; }
export function clearRequestedPairTarget(): void { requestedTarget = null; }
