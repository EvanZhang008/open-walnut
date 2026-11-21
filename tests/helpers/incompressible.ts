/**
 * `n` characters no compression shrinks (random base64), for a file a test moves over a slow link
 * through Walnut's own reader. A range read from another host comes gzipped (fs-read-range-gz-v1,
 * src/core/daemon-file-reader.ts), and a repeated line packs about a hundred times, so a "large"
 * file built from one line crosses the link in seconds and nothing ever waits:
 *   - 2026-11-21, host-read-silent-link-e2e: 3MB crossed the 64KB/s link in 4s;
 *   - 2026-11-21, cloud-host-silent-link.spec.ts: a 5MB history arrived in under 20s, so the
 *     column never said it was still loading from Cloud.
 * Guard: tests/helpers/slow-link-payload-guard.test.ts.
 */
import { randomBytes } from 'node:crypto'

export function noise(n: number): string {
  return randomBytes(Math.ceil((n * 3) / 4)).toString('base64').slice(0, n)
}
