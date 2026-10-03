/**
 * Machine memory signals that fire before the kernel's own pressure level.
 *
 * The macOS level (kern.memorystatus_vm_pressure_level) is late on this kind
 * of machine: on 2026-10-02 swap grew by 1.84 GB in five minutes at 07:02 to
 * 07:07Z, the kernel said "warn" only at 07:14, and the server froze for 23 s
 * at 07:18. The same day an isolated server froze for 7.5 s while the level
 * read normal. Two cheaper signals lead it:
 *
 *  - swap-out rate: bytes written to swap per minute, over a 2 minute window.
 *    Swap USE is not a signal (it stays near full for hours after the pressure
 *    is gone, because pages stay in swap until touched); swap GROWTH is.
 *  - compressor size: physical memory the memory compressor holds, as a share
 *    of RAM (macOS only; Linux zswap is not read).
 *
 * Each has its own hysteresis band (enter high, leave low) so a value hovering
 * at a threshold cannot flip it every reading; memory-pressure.ts then keeps
 * shedding until everything has read normal for the hold (10 minutes, longer
 * while pressure keeps coming back).
 */
export type PressureLevel = 'normal' | 'warn' | 'critical';

/** What made the level non-normal: the kernel, a forced level, or one of the bands. */
export type PressureCause = 'kernel' | 'forced' | 'swapout' | 'compressor' | null;

export interface MemoryReading {
  at: number;
  /** The kernel's own level, when the platform has one. */
  kernel: PressureLevel | null;
  memBytes?: number;
  /** Physical memory held by the compressor (macOS vm.compressor_bytes_used). */
  compressorBytes?: number;
  swapUsedBytes?: number;
  swapTotalBytes?: number;
  /**
   * Cumulative swap-out counter in pages (macOS vm.compressor.swapper.swapouts_total,
   * which counts the compressed segments written, so bytes = pages * pageBytes;
   * Linux pswpout).
   */
  swapoutPages?: number;
  pageBytes?: number;
}

export interface SignalThresholds {
  compressorEnter: number;
  compressorExit: number;
  swapoutEnterBytesPerMin: number;
  swapoutExitBytesPerMin: number;
  swapoutWindowMs: number;
}

const MB = 1024 * 1024;

/**
 * Calibrated 2026-10-02 on this kind of machine (48 GB, 5 GB swap): 6 hours of
 * readings every 15 s, at load 12 to 662, never crossed either enter mark
 * (swap-out peaked at 49 MB/min, the compressor at 38.8% of RAM), while the
 * 07:02Z swap growth (1.84 GB in five minutes, at least 368 MB/min) crosses
 * the swap-out mark 7 to 11 minutes before the kernel said warn. A 35% mark
 * for the compressor would have shed 49% of those 6 hours instead of 20%.
 */
export const DEFAULT_THRESHOLDS: SignalThresholds = {
  compressorEnter: 0.5,
  compressorExit: 0.4,
  swapoutEnterBytesPerMin: 128 * MB,
  swapoutExitBytesPerMin: 16 * MB,
  swapoutWindowMs: 2 * 60_000,
};

export interface SignalState {
  compressorHigh: boolean;
  swapoutHigh: boolean;
  last?: { at: number; swapoutPages: number };
  /** Swap-out bytes per reading interval (from, at], newest last. */
  window: Array<{ from: number; at: number; bytes: number }>;
}

export function initialSignalState(): SignalState {
  return { compressorHigh: false, swapoutHigh: false, window: [] };
}

export interface SignalVerdict {
  level: PressureLevel;
  cause: PressureCause;
  compressorShare: number | null;
  swapoutBytesPerMin: number | null;
  state: SignalState;
}

/** One reading through the bands. Pure; the caller keeps the state. */
export function nextSignal(prev: SignalState, r: MemoryReading, t: SignalThresholds = DEFAULT_THRESHOLDS): SignalVerdict {
  const state: SignalState = { ...prev, window: prev.window };

  let compressorShare: number | null = null;
  if (r.compressorBytes !== undefined && r.memBytes) {
    compressorShare = r.compressorBytes / r.memBytes;
    state.compressorHigh = compressorShare >= (prev.compressorHigh ? t.compressorExit : t.compressorEnter);
  } else {
    state.compressorHigh = false;
  }

  let swapoutBytesPerMin: number | null = null;
  if (r.swapoutPages !== undefined && r.pageBytes) {
    const last = prev.last;
    // A counter that went backwards (a new boot behind a restored state) starts over.
    if (last && r.at > last.at && r.swapoutPages >= last.swapoutPages) {
      state.window = [...state.window, { from: last.at, at: r.at, bytes: (r.swapoutPages - last.swapoutPages) * r.pageBytes }];
    }
    state.last = { at: r.at, swapoutPages: r.swapoutPages };
  }
  state.window = state.window.filter((w) => r.at - w.at < t.swapoutWindowMs);
  if (state.window.length > 0) {
    // Averaged over the whole window, so one burst between two readings
    // counts at its real rate, and a long gap (a sleep) dilutes, not spikes.
    const spanMs = Math.max(1, r.at - state.window[0].from);
    swapoutBytesPerMin = state.window.reduce((a, w) => a + w.bytes, 0) / (spanMs / 60_000);
    state.swapoutHigh = swapoutBytesPerMin >= (prev.swapoutHigh ? t.swapoutExitBytesPerMin : t.swapoutEnterBytesPerMin);
  } else {
    state.swapoutHigh = false;
  }

  let level: PressureLevel = 'normal';
  let cause: PressureCause = null;
  if (r.kernel && r.kernel !== 'normal') { level = r.kernel; cause = 'kernel'; }
  else if (state.swapoutHigh) { level = 'warn'; cause = 'swapout'; }
  else if (state.compressorHigh) { level = 'warn'; cause = 'compressor'; }
  return { level, cause, compressorShare, swapoutBytesPerMin, state };
}

const DARWIN_NAMES = [
  'kern.memorystatus_vm_pressure_level',
  'hw.memsize',
  'hw.pagesize',
  'vm.compressor_bytes_used',
  'vm.swapusage',
  'vm.compressor.swapper.swapouts_total',
] as const;
export const DARWIN_SYSCTL_ARGS: readonly string[] = DARWIN_NAMES;

function sizeToBytes(n: string, unit: string): number {
  const f = Number(n);
  const mul = unit === 'G' ? 1024 * MB : unit === 'M' ? MB : unit === 'K' ? 1024 : 1;
  return Math.round(f * mul);
}

/** `sysctl <names>` output ("name: value" lines) to a reading. Missing names stay undefined. */
export function parseDarwinSysctl(text: string, at: number, levelOf: (n: number) => PressureLevel): MemoryReading {
  const r: MemoryReading = { at, kernel: null };
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim();
    const num = Number(val);
    switch (key) {
      case 'kern.memorystatus_vm_pressure_level': if (Number.isFinite(num)) r.kernel = levelOf(num); break;
      case 'hw.memsize': if (Number.isFinite(num)) r.memBytes = num; break;
      case 'hw.pagesize': if (Number.isFinite(num)) r.pageBytes = num; break;
      case 'vm.compressor_bytes_used': if (Number.isFinite(num)) r.compressorBytes = num; break;
      case 'vm.compressor.swapper.swapouts_total': if (Number.isFinite(num)) r.swapoutPages = num; break;
      case 'vm.swapusage': {
        const total = /total = ([\d.]+)([KMG])/.exec(val);
        const used = /used = ([\d.]+)([KMG])/.exec(val);
        if (total) r.swapTotalBytes = sizeToBytes(total[1], total[2]);
        if (used) r.swapUsedBytes = sizeToBytes(used[1], used[2]);
        break;
      }
    }
  }
  return r;
}

/** Linux: /proc/vmstat pswpout and /proc/meminfo (4 KiB pages; no compressor). */
export function parseLinuxProc(vmstat: string, meminfo: string, at: number, kernel: PressureLevel | null): MemoryReading {
  const r: MemoryReading = { at, kernel, pageBytes: 4096 };
  const sw = /^pswpout (\d+)$/m.exec(vmstat);
  if (sw) r.swapoutPages = Number(sw[1]);
  const kb = (k: string): number | undefined => {
    const m = new RegExp(`^${k}:\\s+(\\d+) kB$`, 'm').exec(meminfo);
    return m ? Number(m[1]) * 1024 : undefined;
  };
  r.memBytes = kb('MemTotal');
  const total = kb('SwapTotal');
  const free = kb('SwapFree');
  if (total !== undefined) r.swapTotalBytes = total;
  if (total !== undefined && free !== undefined) r.swapUsedBytes = total - free;
  return r;
}
