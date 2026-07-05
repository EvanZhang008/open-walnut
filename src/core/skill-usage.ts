/**
 * Skill usage telemetry — .usage.json under the global skills dir.
 *
 * Records per-skill view/use counts and timestamps. Viewing a skill counts as
 * using it (the model loads a skill precisely when it intends to apply it).
 * This telemetry feeds future curation (stale/archive decisions) — collect
 * first, curate later.
 *
 * All operations are best-effort: telemetry must NEVER fail a skill read.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { GLOBAL_SKILLS_DIR } from '../constants.js';
import { withFileLock } from '../utils/file-lock.js';
import { log } from '../logging/index.js';

export interface SkillUsageRecord {
  use_count: number;
  view_count: number;
  last_used_at?: string;
  created_at?: string;
  created_by?: string;
  last_patched_at?: string;
}

export type SkillUsageMap = Record<string, SkillUsageRecord>;

function usageFilePath(): string {
  return path.join(GLOBAL_SKILLS_DIR, '.usage.json');
}

export function loadSkillUsage(): SkillUsageMap {
  try {
    const raw = fs.readFileSync(usageFilePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as SkillUsageMap) : {};
  } catch {
    return {};
  }
}

async function mutateUsage(fn: (usage: SkillUsageMap) => void): Promise<void> {
  const file = usageFilePath();
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await withFileLock(file, async () => {
      let usage: SkillUsageMap = {};
      try {
        usage = JSON.parse(await fsp.readFile(file, 'utf-8')) as SkillUsageMap;
      } catch {
        // missing/corrupt → start fresh
      }
      fn(usage);
      await fsp.writeFile(file, JSON.stringify(usage, null, 2) + '\n', 'utf-8');
    });
  } catch (err) {
    // Telemetry is best-effort — never propagate.
    log.agent.debug('skill-usage: write failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Record a skill view (view counts as use — loading implies intent to apply). */
export async function bumpSkillUsage(name: string): Promise<void> {
  const now = new Date().toISOString();
  await mutateUsage((usage) => {
    const rec = usage[name] ?? { use_count: 0, view_count: 0 };
    rec.use_count += 1;
    rec.view_count += 1;
    rec.last_used_at = now;
    usage[name] = rec;
  });
}

/** Record skill creation (agent-authored skills get created_by for the learning graph). */
export async function recordSkillCreated(name: string, createdBy = 'agent'): Promise<void> {
  const now = new Date().toISOString();
  await mutateUsage((usage) => {
    const rec = usage[name] ?? { use_count: 0, view_count: 0 };
    rec.created_at = rec.created_at ?? now;
    rec.created_by = rec.created_by ?? createdBy;
    usage[name] = rec;
  });
}

/** Record a patch/edit to an existing skill. */
export async function recordSkillPatched(name: string): Promise<void> {
  const now = new Date().toISOString();
  await mutateUsage((usage) => {
    const rec = usage[name] ?? { use_count: 0, view_count: 0 };
    rec.last_patched_at = now;
    usage[name] = rec;
  });
}

/** Drop the telemetry record when a skill is deleted. */
export async function removeSkillUsage(name: string): Promise<void> {
  await mutateUsage((usage) => {
    delete usage[name];
  });
}
