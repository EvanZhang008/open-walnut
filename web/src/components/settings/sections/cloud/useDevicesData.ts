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
import { keepLastGood, readLastGood } from '@/utils/last-good';
import { timeAgo } from '@/utils/time';
import { fetchDevicesList } from './devices-list';
import { DEVICES_CHANGED_EVENT } from './device-rows-copy';
import { EMPTY_DEVICES_VIEW, cloudErrorLine, isDevicesView, mergeDevicesReply, type DeviceEntry, type DevicesListResponse, type DevicesView } from './devices-reply';
import type { ExposeStatus } from './browser-access-status';
import type { PairingTarget, PairTargetKind } from './usePairDevice';

export type { DeviceEntry, DeviceSelfInfo } from './devices-reply';

/** The last view this browser showed, so a reopened page paints at once (and keeps it through a failed read). */
const LAST_GOOD_KEY = 'walnut:last-good:devices:v1';

export interface DevicesData {
  devices: DeviceEntry[];
  cloudDevices: DeviceEntry[];
  targets: PairingTarget[];
  // Until the list answers, nothing is known: no "No phones" line and no "no address" notice
  // that then vanish and pull a deep-linked section below them upward (C74).
  listState: 'loading' | 'ready' | 'failed';
  tailscale?: { installed: boolean; running: boolean };
  /** `tailscale` is an earlier probe's answer, made at `tailscaleAt` (ISO; null when not known). */
  tailscaleStale: boolean;
  tailscaleAt: string | null;
  /** The cloud half of the list failed to load (the reason, from the server, and the age of the list kept beside it). */
  cloudError: string | null;
  /** The cloud phones shown are the last list read, not this read's (`cloudError` says why). */
  cloudStale: boolean;
  /** This Mac unpaired itself: the cloud half is gone on purpose. */
  cloudUnpaired: boolean;
  cloudWithheld: boolean;
  /** The list answered and Tailscale's state is known (or was asked for as often as it will be). */
  settled: boolean;
  refresh: () => Promise<void>;
}

/**
 * The device list. `onTargets` runs with each new list of pairing addresses (the
 * main entry keeps its picker on an address still offered).
 */
export function useDevicesData(opts: { replica: boolean; onTargets?: (kinds: PairTargetKind[]) => void }): DevicesData {
  // Seeded from the last view kept here: shown at once, replaced by the first read.
  const [seed] = useState(() => readLastGood(LAST_GOOD_KEY, isDevicesView)?.value ?? null);
  const [view, setView] = useState<DevicesView>(seed ?? EMPTY_DEVICES_VIEW);
  const [listState, setListState] = useState<DevicesData['listState']>(seed ? 'ready' : 'loading');
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
      setView((prev) => {
        const next = mergeDevicesReply(prev, res, new Date().toISOString());
        keepLastGood(LAST_GOOD_KEY, next);
        return next;
      });
      onTargets.current?.((res.targets ?? []).map((t) => t.kind));
      setListState('ready');
    } catch (err) {
      // A failed read changes nothing shown.
      log.error('settings', 'devices list failed', { error: String(err) });
      if (seq !== readSeq.current) return;
      setListState((prev) => (prev === 'ready' ? prev : 'failed'));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A phone paired or removed elsewhere on the page (the Devices tab, under the tab bar
  // that counts them): read again, so every reader shows the same list.
  useEffect(() => {
    const onChanged = () => { void refresh(); };
    window.addEventListener(DEVICES_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(DEVICES_CHANGED_EVENT, onChanged);
  }, [refresh]);

  // The server leaves Tailscale out of the list until its first probe answers (a newer
  // one sends the last probe's, marked stale): ask again a few times, so the card does
  // not sit on "Checking..." or an old answer (an older server never says).
  // The count is state, not a ref: a read that still lacks the field changes nothing else,
  // and the next ask (and `settled` after the last) must still follow it.
  const [tailscaleAsks, setTailscaleAsks] = useState(0);
  const { replica } = opts;
  const { tailscale, tailscaleStale } = view;
  useEffect(() => {
    if (replica || listState !== 'ready' || (tailscale && !tailscaleStale) || tailscaleAsks >= 3) return;
    const t = setTimeout(() => {
      void refresh().finally(() => setTailscaleAsks((n) => n + 1));
    }, 4_000);
    return () => clearTimeout(t);
  }, [replica, listState, tailscale, tailscaleStale, tailscaleAsks, refresh]);

  const settled = listState !== 'loading' && (replica || listState === 'failed' || !!tailscale || tailscaleAsks >= 3);
  const cloudError = cloudErrorLine(view, (iso) => timeAgo(iso, { long: true }));
  return {
    devices: view.devices, cloudDevices: view.cloudDevices, targets: view.targets, listState, tailscale,
    tailscaleStale: !!tailscaleStale, tailscaleAt: view.tailscaleAt ?? null,
    cloudError, cloudStale: view.cloudStale, cloudUnpaired: view.cloudUnpaired, cloudWithheld: view.cloudWithheld, settled, refresh,
  };
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
