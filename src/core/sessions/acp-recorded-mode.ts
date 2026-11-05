/**
 * The mode a session's record names, and whether a person or an agent chose it.
 *
 * Before 2026-11-05 every ACP start that named no mode recorded 'default' (a
 * hardcoded fallback in the ACP start), so on an ACP record a 'default' without
 * `modeChosen` tells nothing: it reads as Walnut's default (bypass), the mode such
 * a start runs in now, and never moves the adapter off full access or fails a
 * start. Every other value was named by someone (the fallback wrote only
 * 'default'), and `modeChosen` marks a 'default' that was. A Claude Code record's
 * mode is always the one its CLI ran with.
 */
import { isAcpEngine } from '../agents/engine-registry.js';
import { DEFAULT_SESSION_MODE, type SessionMode, type SessionRecord } from '../types.js';

export function recordedSessionMode(
  record: Pick<SessionRecord, 'engine' | 'modeChosen'> & { mode?: SessionMode },
): { mode: SessionMode; chosen: boolean } {
  if (!record.mode) return { mode: DEFAULT_SESSION_MODE, chosen: false };
  if (isAcpEngine(record.engine) && record.mode === 'default' && record.modeChosen !== true) {
    return { mode: DEFAULT_SESSION_MODE, chosen: false };
  }
  return { mode: record.mode, chosen: true };
}
