/**
 * `toEqual` on bytes compares them as bytes.
 *
 * vitest's deep equality walks a Buffer one index at a time: on a Linux host a 3 MB Buffer
 * took 19 s and a 2 MB slice 14 s, against 1 ms for Buffer.equals (2026-11-07). A test
 * comparing a few such bodies ran into the 15 s test timeout whenever the machine was loaded
 * (tests/web/routes/api-v1-files-cloud.test.ts, at load 450 on the Mac).
 *
 * Two byte arrays of the same class (Buffer and Buffer, Uint8Array and Uint8Array) are equal
 * exactly when their bytes are; anything else is left to vitest's own rules, so a Buffer is
 * still not equal to a plain Uint8Array where vitest says so. A mismatch still fails, with
 * vitest's usual message.
 *
 * Every vitest config loads this file (tests/setup/byte-equality.test.ts checks them).
 */
import { expect } from 'vitest'

export function bytesEqual(a: unknown, b: unknown): boolean | undefined {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return undefined
  if (a.constructor !== b.constructor) return undefined
  if (a.byteLength !== b.byteLength) return false
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength))
}

expect.addEqualityTesters([bytesEqual])
