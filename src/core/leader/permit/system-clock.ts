/**
 * The machine's own clocks, read through libc with bun:ffi. Both are the machine's, not the
 * process's: every process on it reads the same value.
 * - boot: counts the time the machine slept (Linux CLOCK_BOOTTIME, macOS mach_continuous_time).
 * - mono: stops while it sleeps (Linux CLOCK_MONOTONIC, macOS mach_absolute_time).
 * A read is one call into libc with no I/O (about 0.4 us measured on Linux), so it never
 * blocks the event loop. Where bun:ffi or a known libc is missing (Node, Windows, a 32-bit
 * build), it gives null and the caller falls back: clock.ts takes the larger of the monotonic
 * and the wall clock and marks its records 'mono-wall'.
 */

export interface SystemClocks {
  kind: 'boottime' | 'continuous'
  /** Milliseconds, sleep included. */
  boot(): number
  /** Milliseconds, sleep left out. */
  mono(): number
}

/** The part of bun:ffi used here (the repository's TypeScript has no bun types). */
export interface Ffi {
  dlopen(lib: string, defs: Record<string, { args: unknown[]; returns: unknown }>): { symbols: Record<string, (...a: unknown[]) => unknown> }
  FFIType: { i32: unknown; ptr: unknown; u64: unknown }
  ptr(view: ArrayBufferView): unknown
}
declare const require: (id: string) => unknown

const LINUX_LIBC = ['libc.so.6', 'libc.so', '/lib/ld-musl-x86_64.so.1', '/lib/ld-musl-aarch64.so.1']
const CLOCK_MONOTONIC = 1
const CLOCK_BOOTTIME = 7

function linuxClocks(ffi: Ffi): SystemClocks | null {
  for (const lib of LINUX_LIBC) {
    try {
      const { symbols } = ffi.dlopen(lib, { clock_gettime: { args: [ffi.FFIType.i32, ffi.FFIType.ptr], returns: ffi.FFIType.i32 } })
      // struct timespec on a 64-bit build: two 64-bit fields, seconds and nanoseconds. The
      // array owns a buffer of its own from the start, so its storage never moves (a small
      // typed array's storage moves the first time anything reads its .buffer) and the
      // pointer stays good; it is still taken again on each read, which costs nothing.
      const ts = new BigInt64Array(new ArrayBuffer(16))
      const read = (id: number): number => {
        if (symbols.clock_gettime!(id, ffi.ptr(ts)) !== 0) throw new Error(`clock_gettime(${id}) failed`)
        return Number(ts[0]!) * 1_000 + Number(ts[1]!) / 1e6
      }
      read(CLOCK_BOOTTIME)
      return { kind: 'boottime', boot: () => read(CLOCK_BOOTTIME), mono: () => read(CLOCK_MONOTONIC) }
    } catch { /* the next name */ }
  }
  return null
}

function darwinClocks(ffi: Ffi): SystemClocks | null {
  try {
    const { symbols } = ffi.dlopen('/usr/lib/libSystem.B.dylib', {
      mach_continuous_time: { args: [], returns: ffi.FFIType.u64 },
      mach_absolute_time: { args: [], returns: ffi.FFIType.u64 },
      mach_timebase_info: { args: [ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
    })
    // struct mach_timebase_info { uint32 numer; uint32 denom }: ticks * numer / denom = ns.
    const tb = new Uint32Array(2)
    if (symbols.mach_timebase_info!(ffi.ptr(tb)) !== 0 || !tb[0] || !tb[1]) return null
    const msPerTick = tb[0] / tb[1] / 1e6
    return {
      kind: 'continuous',
      boot: () => Number(symbols.mach_continuous_time!() as bigint | number) * msPerTick,
      mono: () => Number(symbols.mach_absolute_time!() as bigint | number) * msPerTick,
    }
  } catch {
    return null
  }
}

/**
 * Load the clocks for `platform`. It counts only once both read back sane: finite, and the
 * clock that counts sleep never behind the one that does not.
 */
export function loadSystemClocks(platform: NodeJS.Platform = process.platform, loadFfi: () => Ffi | null = defaultFfi): SystemClocks | null {
  if (process.arch !== 'x64' && process.arch !== 'arm64') return null
  let ffi: Ffi | null
  try { ffi = loadFfi() } catch { return null }
  if (!ffi) return null
  const c = platform === 'linux' ? linuxClocks(ffi) : platform === 'darwin' ? darwinClocks(ffi) : null
  if (!c) return null
  try {
    const m = c.mono()
    const b = c.boot()
    if (!Number.isFinite(b) || !Number.isFinite(m) || b + 1 < m) return null
  } catch {
    return null
  }
  return c
}

function defaultFfi(): Ffi | null {
  if (typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') return null
  return require('bun:ffi') as Ffi
}

let cached: SystemClocks | null | undefined

/** The machine's clocks, loaded once per process; null where they cannot be read. */
export function systemClocks(): SystemClocks | null {
  if (cached === undefined) cached = loadSystemClocks()
  return cached
}
