import { SESSION_MODES, SESSION_MODE_LABELS, type SessionMode } from '@open-walnut/core';
import type { LaunchSourceRow } from '@/utils/launch-source';
import { PermissionModeMenu } from './PermissionModeMenu';

/** Mode names that also name a model or an effort, so the draft's pill adds "mode" (no prefix). */
const MODE_NAMES_THAT_NEED_A_NOUN: ReadonlySet<SessionMode> = new Set<SessionMode>(['default', 'auto']);

/**
 * DraftModePill — the permission mode the session will START in, in the same
 * spot and dress as a running session's mode pill (`.mode-toggle-pill`, Plan in
 * amber). Before any pick it reads the launch default (Bypass), because that is
 * what the spawn does with no mode; a click opens the mode menu and Shift+Tab
 * steps through the enabled cycle (Settings › Sessions). A user who starts a task
 * could not see, let alone choose, whether it would run with full trust or in
 * Plan mode until the session was already up (2026-10-01).
 */
export function DraftModePill({ mode, onPick, nextMode, source }: {
  mode: SessionMode;
  nextMode: SessionMode;
  onPick: (mode: SessionMode) => void;
  /** Where the mode comes from (its project's default, the global one): said in the title, and a
   *  project's default also on the pill. */
  source?: LaunchSourceRow;
}) {
  const labels = SESSION_MODE_LABELS as Record<string, string>;
  const label = labels[mode] ?? mode;
  const description = SESSION_MODES.find((m) => m.id === mode)?.description;
  // Default and Auto are also words for a model or an effort: beside the model pill they say they
  // are the mode ("Default mode").
  return (
    <PermissionModeMenu
      mode={mode}
      onPick={onPick}
      className="draft-mode-pill"
      heading="This task starts in"
      data-mode={mode}
      data-source={source?.source}
      {...(MODE_NAMES_THAT_NEED_A_NOUN.has(mode) ? { label: `${label} mode` } : {})}
      aria-label={`Permission mode: ${label}`}
      title={`Starts in ${label} mode${description ? ` (${description.toLowerCase()})` : ''}${source ? `: ${source.words.charAt(0).toLowerCase()}${source.words.slice(1)}` : ''}. Click to choose a mode; Shift+Tab steps to ${labels[nextMode] ?? nextMode}`}
    />
  );
}
