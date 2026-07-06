/**
 * Skill history logs — the append-only progress trail of a skill
 * (skills/<category>/<name>/history/log.md). The per-category `overview`
 * skill is the most common target; any curated skill can carry history.
 *
 * Convention (memory/skill/history unification):
 * - skills/<category>/<name>/SKILL.md = the living curated doc — edited in place.
 * - skills/<category>/<name>/history/log.md = timestamped progress entries —
 *   append-only, written via THIS module only.
 *
 * MECHANICS ARE CODE, CONTENT IS AI: callers (task hooks, background review,
 * the butler, session on-stop summaries) provide entry text; this module owns
 * file targeting, size-based rotation, and naming. AI never picks filenames
 * and never edits archives.
 *
 * Rotation: when log.md + the new entry would exceed ROTATE_LIMIT, log.md is
 * renamed to log.<yyyymmdd>-<seq>.md (date-stamped volume names double as the
 * time index) and a fresh log.md starts with a link to the previous volume.
 *
 * Search: volumes are plain md under skills/ — covered by the QMD skill
 * collection's all-md glob; no separate index.
 */
import fs from 'node:fs';
import path from 'node:path';
import { GLOBAL_SKILLS_DIR } from '../constants.js';
import { log } from '../logging/index.js';

/** Rotate when the current volume would exceed this (bytes). */
export const OVERVIEW_LOG_ROTATE_LIMIT = 48 * 1024;

const CURRENT_LOG = 'log.md';

function validateSegment(kind: string, value: string): void {
  if (!value || value.includes('..') || value.includes('/') || value.includes('\\')) {
    throw new Error(`Invalid ${kind} "${value}": must be a simple name without path separators.`);
  }
}

function skillDir(category: string, name: string): string {
  validateSegment('category', category);
  validateSegment('skill name', name);
  return path.join(GLOBAL_SKILLS_DIR, category, name);
}

export function skillHistoryDir(category: string, name: string): string {
  return path.join(skillDir(category, name), 'history');
}

/** True when the skill exists (SKILL.md present). */
export function hasSkillDir(category: string, name: string): boolean {
  try {
    return fs.existsSync(path.join(skillDir(category, name), 'SKILL.md'));
  } catch {
    return false;
  }
}

export function overviewDir(category: string): string {
  return skillDir(category, 'overview');
}

export function overviewHistoryDir(category: string): string {
  return skillHistoryDir(category, 'overview');
}

/** True when the category has an overview skill (SKILL.md exists). */
export function hasOverview(category: string): boolean {
  return hasSkillDir(category, 'overview');
}

/** Next archive volume name for today: log.<yyyymmdd>-<seq>.md */
function nextVolumeName(historyDir: string, now: Date): string {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  let seq = 1;
  while (fs.existsSync(path.join(historyDir, `log.${stamp}-${seq}.md`))) seq++;
  return `log.${stamp}-${seq}.md`;
}

export interface OverviewLogAppendResult {
  file: string;
  rotated: boolean;
  archivedVolume?: string;
}

/**
 * Append one timestamped entry to a skill's history log, rotating by size
 * first when needed. Throws when the skill doesn't exist — callers decide
 * whether that's skip-silently (hooks) or an error surfaced to the model
 * (skill_manage / file tools).
 */
export function appendSkillHistoryLog(
  category: string,
  name: string,
  text: string,
  source?: string,
  /** Title used in the volume header. Defaults to the category for overview
   *  logs (back-compat with existing volumes) and the skill name otherwise. */
  headerTitle?: string,
): OverviewLogAppendResult {
  // Validate BEFORE hasSkillDir — its try/catch would mask the validation error.
  validateSegment('category', category);
  validateSegment('skill name', name);
  const entryText = (text ?? '').trim();
  if (!entryText) throw new Error('History log entry text is empty.');
  if (!hasSkillDir(category, name)) {
    throw new Error(
      `Skill "${category}/${name}" does not exist (skills/${category}/${name}/SKILL.md). Create it first.`,
    );
  }

  const title = headerTitle ?? (name === 'overview' ? category : name);
  const historyDir = skillHistoryDir(category, name);
  fs.mkdirSync(historyDir, { recursive: true });
  const current = path.join(historyDir, CURRENT_LOG);

  const now = new Date();
  const ts = now.toISOString().slice(0, 16).replace('T', ' ');
  const entry = `## ${ts}${source ? ` — ${source}` : ''}\n\n${entryText}\n\n`;

  // Size-based rotation BEFORE appending, so one volume never exceeds the cap.
  let rotated = false;
  let archivedVolume: string | undefined;
  try {
    const size = fs.existsSync(current) ? fs.statSync(current).size : 0;
    if (size > 0 && size + Buffer.byteLength(entry, 'utf-8') > OVERVIEW_LOG_ROTATE_LIMIT) {
      archivedVolume = nextVolumeName(historyDir, now);
      fs.renameSync(current, path.join(historyDir, archivedVolume));
      fs.writeFileSync(
        current,
        `# ${title} progress log\n\nPrevious volume: [${archivedVolume}](./${archivedVolume})\n\n`,
        'utf-8',
      );
      rotated = true;
    }
  } catch (err) {
    // Rotation is best-effort — a failed rotate must not lose the entry.
    log.memory.warn('skill-history: rotation failed, appending to current volume', {
      category,
      name,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!fs.existsSync(current)) {
    fs.writeFileSync(current, `# ${title} progress log\n\n`, 'utf-8');
  }
  fs.appendFileSync(current, entry, 'utf-8');
  return { file: current, rotated, archivedVolume };
}

/**
 * Append one timestamped entry to the category's overview history log.
 * Thin wrapper over appendSkillHistoryLog(category, 'overview', ...).
 */
export function appendOverviewLog(
  category: string,
  text: string,
  source?: string,
): OverviewLogAppendResult {
  if (!hasOverview(category)) {
    // Keep the overview-specific error message (skill_manage/tests rely on it).
    validateSegment('category', category);
    throw new Error(
      `Category "${category}" has no overview skill (skills/${category}/overview/SKILL.md). Create it first.`,
    );
  }
  return appendSkillHistoryLog(category, 'overview', text, source);
}

/**
 * Best-effort routing of a task-scoped progress entry into the skill system.
 * Used by session on-stop summaries and legacy memory/project appends.
 *
 * Resolution order (all lowercase-normalized):
 * 1. skills/<category>/<project>/history/  — a curated skill matching the project
 * 2. skills/<category>/overview/history/   — the category's overview log
 * Returns null when neither exists (caller decides: hooks skip silently, the
 * daily log has the entry regardless).
 */
export function appendSkillHistoryForProject(
  category: string,
  project: string,
  text: string,
  source?: string,
): OverviewLogAppendResult | null {
  const cat = (category ?? '').trim().toLowerCase();
  const proj = (project ?? '').trim().toLowerCase();
  try {
    if (proj && hasSkillDir(cat, proj)) {
      return appendSkillHistoryLog(cat, proj, text, source);
    }
    if (hasOverview(cat)) {
      return appendSkillHistoryLog(cat, 'overview', text, source);
    }
  } catch (err) {
    log.memory.warn('skill-history: project-scoped append failed', {
      category: cat,
      project: proj,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}
