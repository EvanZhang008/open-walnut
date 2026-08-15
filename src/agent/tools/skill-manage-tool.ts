/**
 * Agent tool: skill_manage
 * Create/patch/edit/delete skills — the Personal AI's write path into the unified
 * skill system (type: action = procedures, knowledge = curated domain facts).
 *
 * The schema embeds the update triggers so condensation happens IN conversation
 * (no background extractor). Description ≤60 chars is HARD-validated: the
 * description is the routing signal in the skill index — long descriptions
 * get truncated and silently break routing.
 */
import type { ToolDefinition } from '../tools.js';
import yaml from 'js-yaml';
import {
  createSkill,
  updateSkill,
  deleteSkill,
  getSkill,
} from '../../core/skill-store.js';
import { clearSkillsCache } from '../../core/skill-loader.js';
import { screenSkillWrite } from '../../core/memory-safety.js';
import { recordSkillCreated, recordSkillPatched, removeSkillUsage } from '../../core/skill-usage.js';
import { dispatchQmdIncrementalIndex } from '../../core/qmd-dispatcher.js';
import { appendOverviewLog, appendSkillHistoryLog } from '../../core/overview-log.js';
import { log } from '../../logging/index.js';

export const MAX_SKILL_DESC_CHARS = 60;

/** Refresh the QMD skill collection in the background (best-effort). */
function refreshSkillIndex(): void {
  void dispatchQmdIncrementalIndex({ memory: true }).catch((err) => {
    log.agent.debug('skill_manage: QMD skill index refresh failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Injection screen for a skill write (see memory-safety.ts). The writer is a
 * model that may itself be under an attacker's influence — the Personal AI distils
 * skills from conversation content, and the unattended background-review fork
 * does the same with nobody watching — so the cheapest place to stop a payload
 * is before it reaches disk. Only the text the model SUPPLIES is screened, never
 * the existing file, so a skill that is already poisoned can still be patched or
 * deleted. Returns a tool-error string, or null to allow.
 */
function screenWrite(action: string, name: string, ...parts: Array<string | undefined>): string | null {
  const text = parts.filter(Boolean).join('\n\n');
  const err = screenSkillWrite(text, `skill_manage ${action} '${name}'`);
  return err ? `Error: ${err}` : null;
}

function validateDescription(description: string): string | null {
  const d = (description ?? '').trim();
  if (!d) return 'description is required.';
  if (d.length > MAX_SKILL_DESC_CHARS) {
    return `description is ${d.length} chars — must be ≤${MAX_SKILL_DESC_CHARS}. It is the ROUTING signal in the skill index; write ONE short sentence stating when to use this skill.`;
  }
  return null;
}

function buildSkillMd(opts: {
  name: string;
  description: string;
  type: 'action' | 'knowledge';
  content: string;
  /** Existing frontmatter to merge (preserves category override, metadata.openclaw gating, custom keys). */
  base?: Record<string, unknown>;
}): string {
  const fm = yaml.dump(
    { ...(opts.base ?? {}), name: opts.name, description: opts.description, type: opts.type },
    { lineWidth: 120 },
  );
  return `---\n${fm}---\n\n${opts.content.trim()}\n`;
}

/** Extract raw frontmatter object from a SKILL.md (empty object when absent/invalid). */
function parseRawFrontmatter(raw: string): Record<string, unknown> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  try {
    const parsed = yaml.load(match[1]);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const skillManageTool: ToolDefinition = {
  name: 'skill_manage',
  description: `The skill-learning tool — curated knowledge + reusable procedures, loaded on demand via the skill index. Route what you learned to the right store:
- **skill, type action**: a reusable procedure/how-to (steps to accomplish something).
- **skill, type knowledge**: curated stable facts about a topic/domain (a living wiki page).
- Behavior rules + who-the-user-is → NOT here: use memory_manage (target memory / user).
- Episodic events ("did X last week") → the daily log (file_write memory/daily). Past conversations are searchable via history_search; never saved here.

## Update triggers — act on these DURING the conversation, don't wait
1. You used a skill and hit an issue it didn't cover → **patch it immediately, BEFORE finishing the task**.
2. You completed a complex task (multi-step, errors overcome, or user corrected you) → **offer to save it as an action skill**.
3. A new stable fact about an existing knowledge skill's topic surfaced → **patch that skill now** (no need to ask).
4. A topic keeps recurring across conversations with no knowledge skill → **create one** (ask the user first).
5. A fact in a skill is corrected or outdated → **replace it in place — never append a duplicate**.

## Rules
- description ≤${MAX_SKILL_DESC_CHARS} chars, HARD limit — it's the routing signal. One sentence: when to use this skill.
- category groups skills (e.g. finance, career, walnut, repos). Reuse existing categories when one fits.
- Creating a NEW skill: confirm with the user first. Patching an existing one: just do it (reversible, git-synced).

## Overview skills (per-category living project doc)
Each category MAY have an \`overview\` skill (skills/<category>/overview/SKILL.md): what the project is, current direction, big decisions/milestones. Keep it organized — edit/patch it when direction changes. Its progress trail lives in history/log.md, written ONLY via log_append (rotation and file naming are automatic — never write history files directly).

## Actions
- create: new skill (name, category, type, description, content).
- patch: exact string replacement inside an existing skill (old_string → new_string).
- edit: full content replacement of an existing skill's SKILL.md body (keeps or updates frontmatter via description/type params).
- delete: remove a skill entirely.
- log_append: append ONE timestamped progress entry to a skill's history log (category, content; optional name — default: the category's overview). Use for notable project progress ("shipped X", "decided Y over Z because..."). Episodic detail belongs here, NEVER in the curated SKILL.md body.`,
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'patch', 'edit', 'delete', 'log_append'],
        description: 'The operation to perform. skill ops: create/patch/edit/delete. overview log: log_append.',
      },
      name: {
        type: 'string',
        description: 'Skill name (kebab-case, alphanumeric/hyphens/underscores). Required for skill actions.',
      },
      category: {
        type: 'string',
        description: 'For create: grouping category (e.g. finance, career, walnut). Reuse existing ones when possible. For log_append: the category whose overview history log to append to (required).',
      },
      type: {
        type: 'string',
        enum: ['action', 'knowledge'],
        description: 'For create/edit: action = procedure, knowledge = curated domain facts.',
      },
      description: {
        type: 'string',
        description: `For create/edit: ONE sentence, ≤${MAX_SKILL_DESC_CHARS} chars — when to use this skill (hard-validated).`,
      },
      content: {
        type: 'string',
        description: 'For create/edit: the skill body markdown (without frontmatter — it is generated). For log_append: the progress entry text.',
      },
      old_string: {
        type: 'string',
        description: 'For patch: exact text to find in the SKILL.md.',
      },
      new_string: {
        type: 'string',
        description: 'For patch: replacement text.',
      },
    },
    required: ['action'],
  },
  async execute(params) {
    const action = params.action as string;
    const name = params.name as string;

    try {
      // Migration guard: memory_* lived here pre-split (2026-07). Redirect
      // stale calls explicitly instead of a misleading "name is required".
      if (action.startsWith('memory_')) {
        return `Unknown action '${action}'. Memory writes moved to the memory_manage tool (actions: add/replace/remove/batch; target: memory | user).`;
      }

      if (action === 'log_append') {
        const category = (params.category as string) ?? '';
        const content = (params.content as string) ?? '';
        if (!category) return 'Error: category is required for log_append.';
        if (!content.trim()) return 'Error: content is required for log_append.';
        // Optional name targets a specific skill's history (skills/<cat>/<name>/history/);
        // default is the category's overview log.
        const targetName = (params.name as string | undefined)?.trim() || 'overview';
        // History logs are read back by the Personal AI and feed the overview skills,
        // so they get the same screen as a skill body.
        const logErr = screenWrite('log_append', `${category}/${targetName}`, content);
        if (logErr) return logErr;
        const result = targetName === 'overview'
          ? appendOverviewLog(category, content, 'Personal AI')
          : appendSkillHistoryLog(category, targetName, content, 'Personal AI');
        refreshSkillIndex();
        log.agent.info('skill_manage: history log appended', {
          category, name: targetName, rotated: result.rotated, archivedVolume: result.archivedVolume,
        });
        const target = targetName === 'overview' ? `${category}'s overview` : `${category}/${targetName}'s`;
        return `Progress entry appended to ${target} history log${result.rotated ? ` (volume rotated: previous archived as ${result.archivedVolume})` : ''}. This update is complete — do not repeat it.`;
      }

      if (!name) return `Error: name is required for skill action '${action}'.`;

      if (action === 'create') {
        const description = (params.description as string) ?? '';
        const descError = validateDescription(description);
        if (descError) return `Error: ${descError}`;
        const content = (params.content as string) ?? '';
        if (!content.trim()) return 'Error: content is required for create.';
        const type = params.type === 'knowledge' ? 'knowledge' : 'action';
        const category = (params.category as string) ?? undefined;
        const createErr = screenWrite('create', name, description, content);
        if (createErr) return createErr;

        const md = buildSkillMd({ name, description: description.trim(), type, content });
        const skill = await createSkill(name, md, 'walnut', category);
        await recordSkillCreated(name);
        clearSkillsCache();
        refreshSkillIndex();
        log.agent.info('skill_manage: created skill', { name, category: skill.category, type });
        return `Skill '${name}' created (category: ${skill.category}, type: ${type}). It is now in the skill index.`;
      }

      if (action === 'patch') {
        const oldString = params.old_string as string | undefined;
        const newString = params.new_string as string | undefined;
        if (!oldString) return 'Error: old_string is required for patch.';
        if (newString === undefined) return 'Error: new_string is required for patch.';
        // Only new_string is screened: old_string is quoted from the file, so
        // screening it would block the very patch that removes a poisoned line.
        const patchErr = screenWrite('patch', name, newString);
        if (patchErr) return patchErr;

        const skill = await getSkill(name);
        if (!skill) return `Error: skill not found: ${name}`;
        const occurrences = skill.content.split(oldString).length - 1;
        if (occurrences === 0) {
          return `Error: old_string not found in '${name}'. Use skill_view to read the current content, then retry with exact text.`;
        }
        if (occurrences > 1) {
          return `Error: old_string matches ${occurrences} locations in '${name}'. Provide more surrounding context to make it unique.`;
        }
        const updated = skill.content.replace(oldString, newString);
        await updateSkill(name, updated);
        await recordSkillPatched(name);
        clearSkillsCache();
        refreshSkillIndex();
        log.agent.info('skill_manage: patched skill', { name });
        return `Skill '${name}' patched. This update is complete — do not repeat it.`;
      }

      if (action === 'edit') {
        const content = (params.content as string) ?? '';
        if (!content.trim()) return 'Error: content is required for edit.';
        const skill = await getSkill(name);
        if (!skill) return `Error: skill not found: ${name}`;

        // Rebuild frontmatter: keep existing values unless new ones are provided.
        const description = ((params.description as string) ?? skill.description).trim();
        const descError = validateDescription(description);
        if (descError) return `Error: ${descError}`;
        const type = params.type === 'knowledge' || params.type === 'action'
          ? (params.type as 'action' | 'knowledge')
          : skill.type;
        // Screen only what the model supplied. `description` may have fallen back
        // to the existing frontmatter value, so pass the supplied one only.
        const editErr = screenWrite('edit', name, params.description as string | undefined, content);
        if (editErr) return editErr;

        // Merge onto the EXISTING frontmatter — a rebuild from just name/desc/type
        // would silently drop category overrides and metadata.openclaw gating.
        const base = parseRawFrontmatter(skill.content);
        const md = buildSkillMd({ name: skill.name, description, type, content, base });
        await updateSkill(name, md);
        await recordSkillPatched(name);
        clearSkillsCache();
        refreshSkillIndex();
        log.agent.info('skill_manage: edited skill', { name, type });
        return `Skill '${name}' rewritten. This update is complete — do not repeat it.`;
      }

      if (action === 'delete') {
        await deleteSkill(name);
        await removeSkillUsage(name);
        clearSkillsCache();
        refreshSkillIndex();
        log.agent.info('skill_manage: deleted skill', { name });
        return `Skill '${name}' deleted.`;
      }

      return `Unknown action '${action}'. Skill actions: create, patch, edit, delete, log_append. (Memory writes moved to the memory_manage tool.)`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
