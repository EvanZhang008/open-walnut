/**
 * Which archive this machine takes: `<os>-<arch>`, plus `-musl` on a Linux whose
 * C library is musl (Alpine), where glibc builds do not load.
 *
 * Detected once, with async IO: the musl dynamic loader sits at
 * /lib/ld-musl-<arch>.so.1 on every musl system. WALNUT_COMPONENTS_PLATFORM
 * overrides it (tests, and a Mac staging an archive for a host).
 */

import { access } from 'node:fs/promises';
import { PLATFORMS, type Platform } from './types.js';

let detected: Promise<Platform | null> | null = null;
let known: Platform | null | undefined;

export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value);
}

function base(platform = process.platform, arch = process.arch): string | null {
  if (platform !== 'darwin' && platform !== 'linux') return null;
  if (arch !== 'x64' && arch !== 'arm64') return null;
  return `${platform}-${arch}`;
}

async function detect(): Promise<Platform | null> {
  const override = process.env.WALNUT_COMPONENTS_PLATFORM;
  if (override) return isPlatform(override) ? override : null;
  const b = base();
  if (!b) return null;
  if (process.platform !== 'linux') return b as Platform;
  const loader = `/lib/ld-musl-${process.arch === 'x64' ? 'x86_64' : 'aarch64'}.so.1`;
  const musl = await access(loader).then(() => true, () => false);
  return (musl ? `${b}-musl` : b) as Platform;
}

/** This machine's platform, or null for one no component is built for (Windows, 32-bit). */
export function currentPlatform(): Promise<Platform | null> {
  detected ??= detect().then((p) => { known = p; return p; });
  return detected;
}

/** The platform once currentPlatform() has answered; before that, the glibc guess. */
export function currentPlatformSync(): Platform | null {
  if (known !== undefined) return known;
  const override = process.env.WALNUT_COMPONENTS_PLATFORM;
  if (override) return isPlatform(override) ? override : null;
  return base() as Platform | null;
}

/** Test seam: forget the detected platform. */
export function resetPlatformForTests(): void {
  detected = null;
  known = undefined;
}
