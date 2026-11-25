import { fetchInstallDir } from '@/api/config';
import { createUiFlag } from './ui-flag';

/**
 * `ui.show_hidden_lines`: whether the session chat shows, folded under a reply, the lines
 * Walnut hid from it (its status lines, a turn-end marker, a tasks line: src/lib/internal-lines.ts).
 * Settings > Advanced. Unset, it is on for a developer and off for everyone else (2026-11-25, the
 * user, translated: "I am a developer, so for me it shows by default; for ordinary users it does
 * not"): a developer is a Walnut that runs from its own source checkout (the server's `installDir`,
 * which also drives Fix Walnut). Shown, the lines are a fold that opens on a click (the user: "when
 * it shows, it is collapsed, and it can collapse").
 */
const flag = createUiFlag({
  key: 'show_hidden_lines',
  storageKey: 'walnut:show-hidden-lines',
  fallback: false,
  whenUnset: () => fetchInstallDir().then((dir) => dir !== null),
});

export const useShowHiddenLines = flag.use;

export const setShowHiddenLines = flag.set;
