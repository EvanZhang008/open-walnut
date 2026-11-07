/**
 * The process on the other end of a connected unix socket, as the kernel records it
 * (2026-11-07: an approval asked through a host daemon's gateway socket must be checked against
 * the asking process, never the session id it sends). macOS: getsockopt(SOL_LOCAL,
 * LOCAL_PEERPID); Linux: getsockopt(SOL_SOCKET, SO_PEERCRED). Read through libc with bun:ffi,
 * so only the bun-built daemon has it; where libc cannot be loaded it reads nothing, and a caller
 * then treats the asker as unchecked (a single-use approval is refused).
 */

type PeerPid = (fd: number) => number | undefined

/** The part of bun:ffi used here (the repository's TypeScript has no bun types). */
interface Ffi {
  dlopen(lib: string, defs: Record<string, { args: unknown[]; returns: unknown }>): { symbols: Record<string, (...a: unknown[]) => unknown> }
  FFIType: { i32: unknown; ptr: unknown }
  ptr(view: ArrayBufferView): unknown
}
declare const require: (id: string) => unknown

let loaded: PeerPid | null | undefined

const LIBC: Record<string, string[]> = {
  darwin: ['libSystem.B.dylib', '/usr/lib/libSystem.B.dylib'],
  linux: ['libc.so.6', 'libc.so', '/lib/ld-musl-x86_64.so.1', '/lib/ld-musl-aarch64.so.1'],
}

function load(): PeerPid | null {
  const libs = LIBC[process.platform]
  if (!libs || typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') return null
  let ffi: Ffi
  // Synchronous, so the daemon's first hello already says whether it can (caller-proof-v1).
  try { ffi = require('bun:ffi') as Ffi } catch { return null }
  const mac = process.platform === 'darwin'
  for (const lib of libs) {
    try {
      const { symbols } = ffi.dlopen(lib, {
        getsockopt: { args: [ffi.FFIType.i32, ffi.FFIType.i32, ffi.FFIType.i32, ffi.FFIType.ptr, ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
      })
      return (fd: number) => {
        if (!Number.isInteger(fd) || fd < 0) return undefined
        // macOS: an int pid. Linux: struct ucred { pid, uid, gid }, three ints.
        const out = new Int32Array(mac ? 1 : 3)
        const len = new Uint32Array([out.byteLength])
        const rc = symbols.getsockopt!(fd, mac ? 0 : 1, mac ? 2 : 17, ffi.ptr(out), ffi.ptr(len)) as number
        const pid = out[0]!
        return rc === 0 && pid > 1 ? pid : undefined
      }
    } catch { /* the next name */ }
  }
  return null
}

/** Load the reader once: whether this process can read a socket's peer at all. */
export function socketPeerPidReady(): boolean {
  if (loaded === undefined) loaded = load()
  return !!loaded
}

/** The pid on the other end of the unix socket `fd`, or undefined when it cannot be read. */
export function socketPeerPid(fd: number | undefined): number | undefined {
  if (!socketPeerPidReady() || !loaded || fd === undefined) return undefined
  try { return loaded(fd) } catch { return undefined }
}
