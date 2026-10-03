/**
 * Machine memory context for the stall flight recorder (stall-recorder.ts).
 *
 * Per-process getrusage misses compressor swap-ins on macOS, so a stall record
 * also carries the machine's paging counters over the minute around it (vm_stat
 * is a single host_statistics call, sampled at each profile rotation as the
 * baseline) and, at most every 10 minutes, how much of THIS process sits in the
 * compressor. Every read is an async child process or file read; nothing here
 * runs on the loop for longer than parsing a few lines.
 */

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';

interface VmCounters {
  at: number; pageSize: number; pageins: number; pageouts: number; swapins: number; swapouts: number;
  decompressions: number; compressions: number; freePages: number; compressorPages: number;
}

const FOOTPRINT_MIN_GAP_MS = 10 * 60_000;
let vmBaseline: VmCounters | null = null;
let lastFootprintAt = 0;

const monoMs = (): number => Number(process.hrtime.bigint()) / 1e6;

function execText(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? null : String(stdout)));
    } catch { resolve(null); }
  });
}

async function readVmCounters(): Promise<VmCounters | null> {
  if (process.platform === 'darwin') {
    const text = await execText('vm_stat', [], 3_000);
    if (!text) return null;
    const num = (label: string): number => {
      const m = new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(text);
      return m ? Number(m[1]) : 0;
    };
    const ps = /page size of (\d+) bytes/.exec(text);
    return {
      at: monoMs(), pageSize: ps ? Number(ps[1]) : 16384,
      pageins: num('Pageins'), pageouts: num('Pageouts'), swapins: num('Swapins'), swapouts: num('Swapouts'),
      decompressions: num('Decompressions'), compressions: num('Compressions'),
      freePages: num('Pages free'), compressorPages: num('Pages occupied by compressor'),
    };
  }
  if (process.platform === 'linux') {
    let text: string;
    try { text = await fsp.readFile('/proc/vmstat', 'utf8'); } catch { return null; }
    const num = (k: string): number => { const m = new RegExp(`^${k} (\\d+)`, 'm').exec(text); return m ? Number(m[1]) : 0; };
    return {
      at: monoMs(), pageSize: 4096, pageins: num('pgpgin'), pageouts: num('pgpgout'), swapins: num('pswpin'), swapouts: num('pswpout'),
      decompressions: 0, compressions: 0, freePages: num('nr_free_pages'), compressorPages: 0,
    };
  }
  return null;
}

async function readProcessFootprint(): Promise<Record<string, number> | null> {
  if (process.platform === 'darwin') {
    // top is the cheap public way to read a process's compressed bytes; it
    // costs ~1 s of CPU in the child, hence the 10-minute gap.
    const text = await execText('top', ['-l', '1', '-pid', String(process.pid), '-stats', 'pid,mem,cmprs'], 8_000);
    if (!text) return null;
    const row = text.trim().split('\n').pop() ?? '';
    const m = /^\s*\d+\s+(\S+)\s+(\S+)/.exec(row);
    if (!m) return null;
    const toMb = (v: string): number => {
      const n = parseFloat(v);
      const unit = v.replace(/[\d.+-]/g, '').toUpperCase();
      return Math.round(unit.startsWith('G') ? n * 1024 : unit.startsWith('K') ? n / 1024 : unit.startsWith('B') ? n / 1048576 : n);
    };
    return { footprintMb: toMb(m[1]), compressedMb: toMb(m[2]) };
  }
  if (process.platform === 'linux') {
    try {
      const text = await fsp.readFile('/proc/self/status', 'utf8');
      const kb = (k: string): number => { const m = new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(text); return m ? Math.round(Number(m[1]) / 1024) : 0; };
      return { rssMb: kb('VmRSS'), swappedMb: kb('VmSwap') };
    } catch { return null; }
  }
  return null;
}

/** Take a new paging baseline (called at each profile rotation). */
export function refreshVmBaseline(): void {
  void readVmCounters().then((v) => { if (v) vmBaseline = v; });
}

/** Paging since the baseline, free + compressor size, and (rate-limited) this process's compressed bytes. */
export async function sampleMemContext(): Promise<Record<string, unknown> | null> {
  const base = vmBaseline;
  const wantFootprint = Date.now() - lastFootprintAt >= FOOTPRINT_MIN_GAP_MS;
  if (wantFootprint) lastFootprintAt = Date.now();
  const [vm, fp] = await Promise.all([readVmCounters(), wantFootprint ? readProcessFootprint() : Promise.resolve(null)]);
  const out: Record<string, unknown> = {};
  if (vm) {
    const mbOf = (pages: number): number => Math.round((pages * vm.pageSize) / 1048576);
    out.system = {
      freeMb: mbOf(vm.freePages),
      compressorMb: mbOf(vm.compressorPages),
      ...(base ? {
        overS: Math.round((vm.at - base.at) / 1000),
        swapins: vm.swapins - base.swapins,
        swapouts: vm.swapouts - base.swapouts,
        pageins: vm.pageins - base.pageins,
        decompressions: vm.decompressions - base.decompressions,
        compressions: vm.compressions - base.compressions,
      } : {}),
    };
  }
  if (fp) out.process = fp;
  return Object.keys(out).length > 0 ? out : null;
}

export function resetSystemContext(): void {
  vmBaseline = null;
  lastFootprintAt = 0;
}
