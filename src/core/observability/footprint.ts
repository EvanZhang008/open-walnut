/**
 * This process's physical footprint on macOS: the number Activity Monitor's Memory column shows
 * and the one memory pressure counts. RSS is not it there: the engine's allocator hands freed
 * pages back as reusable (MADV_FREE_REUSABLE), which the kernel takes whenever it needs them, and
 * RSS keeps counting them until it does. 2026-11-24 on the maintainer's Mac: RSS 4,271 MB with a
 * footprint of 1,483 MB, 2,760 MB of it reclaimable (footprint -p), so the ledger's "bursts" to
 * 4 to 5 GB with a flat JS heap were mostly pages already freed.
 *
 * Read with proc_pid_rusage (libproc) through bun:ffi: about 20 microseconds, no child process.
 * Null where it cannot be read (Linux, Node, a failed load): callers fall back to RSS.
 */

const MB = 1024 * 1024;
/** rusage_info_v0: a 16-byte uuid, then u64s; ri_phys_footprint is the 8th u64 after it. */
const RUSAGE_INFO_V0 = 0;
const V0_U64S = 12;
const FOOTPRINT_INDEX = 9;

type Reader = () => number | null;
/** The part of bun:ffi used here (its types are not part of this build). */
interface BunFfi {
  FFIType: { i32: unknown; ptr: unknown };
  ptr(view: ArrayBufferView): unknown;
  dlopen(path: string, symbols: Record<string, { args: unknown[]; returns: unknown }>): {
    symbols: { proc_pid_rusage(pid: number, flavor: number, buffer: unknown): number };
  };
}
let reader: Reader | null | undefined;

function load(): Reader | null {
  if (process.platform !== 'darwin' || !(globalThis as { Bun?: unknown }).Bun) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffi = require('bun:ffi') as BunFfi;
    const lib = ffi.dlopen('/usr/lib/libproc.dylib', {
      proc_pid_rusage: { args: [ffi.FFIType.i32, ffi.FFIType.i32, ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
    });
    const buf = new BigUint64Array(V0_U64S);
    const at = ffi.ptr(buf);
    return () => (lib.symbols.proc_pid_rusage(process.pid, RUSAGE_INFO_V0, at) === 0 ? Number(buf[FOOTPRINT_INDEX]) : null);
  } catch {
    return null;
  }
}

/** The physical footprint in whole MB, or null where it cannot be read. */
export function physFootprintMb(): number | null {
  if (reader === undefined) reader = load();
  if (!reader) return null;
  try {
    const bytes = reader();
    return bytes && bytes > 0 ? Math.round(bytes / MB) : null;
  } catch {
    return null;
  }
}

/** Tests only: read with this instead (null: none). */
export function _setFootprintReaderForTesting(fn: Reader | null | undefined): void {
  reader = fn;
}
