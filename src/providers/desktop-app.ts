/**
 * Find the Walnut.app the user already has, and ask what it can do WITHOUT running it.
 *
 * Shared by everything that puts a macOS permission on the app instead of on a
 * separate helper: the session host (src/providers/session-host.ts) and the
 * calendar bridge (src/core/calendar/sources/eventkit.ts). One app means one row
 * per permission in System Settings, under the name the user knows, on a
 * certificate-signed identity that survives rebuilds.
 *
 * Two rules:
 *  - Support for a flag is read out of the binary, never by executing it. An older
 *    Walnut.app handed a flag it does not know ignores it and boots the GUI, which
 *    puts a window on screen.
 *  - Home is the passwd entry, never `$HOME`: Walnut deliberately runs with a fake
 *    HOME in sandbox/onboarding modes, and looking under a throwaway home would
 *    report "no app" on a machine that has one.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { desktopAppCandidates, desktopAppExecutable } from './session-host-core.js';

/** The REAL user's home, from the passwd entry rather than `$HOME`. */
export function realHome(): string | null {
  try {
    const home = os.userInfo().homedir;
    return home && path.isAbsolute(home) ? home : null;
  } catch {
    return null;
  }
}

/**
 * Does `file` contain `needle`? Chunked with an overlap, so a match spanning two
 * reads is still found. False when the file cannot be read.
 */
export async function binaryContains(file: string, needle: string): Promise<boolean> {
  const bytes = Buffer.from(needle, 'utf8');
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(file, 'r');
  } catch {
    return false;
  }
  try {
    const chunk = 1 << 20;
    const overlap = bytes.length - 1;
    const buffer = Buffer.allocUnsafe(chunk + overlap);
    let carried = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, carried, chunk, null);
      if (bytesRead === 0) return false;
      const filled = buffer.subarray(0, carried + bytesRead);
      if (filled.includes(bytes)) return true;
      // Keep the tail so the next window can complete a straddling match.
      filled.subarray(filled.length - overlap).copy(buffer, 0);
      carried = Math.min(overlap, filled.length);
    }
  } finally {
    await handle.close();
  }
}

export interface DesktopApp {
  /** The bundle, e.g. /Applications/Walnut.app: what the user adds in System Settings. */
  app: string;
  /** Its Mach-O, which is what actually runs. */
  executable: string;
}

/** The first installed Walnut.app, whether or not it knows any particular flag. */
export function findDesktopApp(): DesktopApp | null {
  const home = realHome();
  if (!home) return null;
  const app = desktopAppCandidates(home).find((c) => fs.existsSync(desktopAppExecutable(c)));
  return app ? { app, executable: desktopAppExecutable(app) } : null;
}

// Keyed by the executable's identity on disk, so a rebuilt app is re-read and an
// unchanged one costs a stat per call: the calendar asks on every poll, and the
// app's Mach-O is several MB.
const supportCache = new Map<string, { key: string; supported: boolean }>();

/** The installed Walnut.app when it knows `flag`, else null. Never runs the app. */
export async function findDesktopAppWith(flag: string): Promise<DesktopApp | null> {
  const found = findDesktopApp();
  if (!found) return null;
  let key: string;
  try {
    const st = fs.statSync(found.executable);
    key = `${found.executable}:${st.size}:${st.mtimeMs}:${st.ino}`;
  } catch {
    return null;
  }
  const cacheKey = `${flag}\0${found.executable}`;
  const cached = supportCache.get(cacheKey);
  if (cached?.key === key) return cached.supported ? found : null;
  const supported = await binaryContains(found.executable, flag);
  supportCache.set(cacheKey, { key, supported });
  return supported ? found : null;
}
