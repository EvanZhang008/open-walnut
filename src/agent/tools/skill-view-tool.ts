/**
 * Agent tool: skill_view
 * Load a skill's SKILL.md (or a linked reference file) and bump usage telemetry.
 *
 * Viewing counts as using: the model loads a skill exactly when it intends to
 * apply it, and the telemetry feeds future curation decisions.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition } from '../tools.js';
import { getSkill } from '../../core/skill-store.js';
import { bumpSkillUsage } from '../../core/skill-usage.js';
import { screenDocumentForPrompt } from '../../core/memory-safety.js';

export const skillViewTool: ToolDefinition = {
  name: 'skill_view',
  description: `Load a skill's full SKILL.md content (or one of its reference files). Use this whenever a skill from <available_skills> (or a "Possibly relevant skills" hint) might apply to the current task — err on the side of loading. Viewing is tracked as usage.`,
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The skill name (dirName) as listed in <available_skills>.',
      },
      file_path: {
        type: 'string',
        description:
          'Optional: a file inside the skill directory to read instead of SKILL.md (e.g. "references/setup.md"). Relative to the skill directory.',
      },
    },
    required: ['name'],
  },
  async execute(params) {
    const name = params.name as string;
    const filePath = params.file_path as string | undefined;

    const skill = await getSkill(name);
    if (!skill) {
      return `Skill not found: '${name}'. Check <available_skills> for valid names.`;
    }

    // Telemetry is best-effort — never blocks the read.
    void bumpSkillUsage(name);

    if (filePath) {
      const skillDir = path.dirname(skill.location);
      const resolved = path.resolve(skillDir, filePath);
      if (!resolved.startsWith(skillDir + path.sep)) {
        return 'Invalid file_path: must stay inside the skill directory.';
      }
      try {
        // realpath re-check: a symlink inside the skill dir could point outside
        // it and pass the lexical prefix check above.
        const realDir = await fsp.realpath(skillDir);
        const realFile = await fsp.realpath(resolved);
        if (!realFile.startsWith(realDir + path.sep)) {
          return 'Invalid file_path: must stay inside the skill directory.';
        }
        // A skill body becomes authoritative procedure the moment it is loaded,
        // and reference files are written by the same paths as SKILL.md — screen
        // both. Only the flagged blocks are withheld; the rest reads normally.
        return screenDocumentForPrompt(await fsp.readFile(realFile, 'utf-8'), `skill reference '${name}/${filePath}'`);
      } catch {
        return `File not found in skill '${name}': ${filePath}`;
      }
    }

    return screenDocumentForPrompt(skill.content, `skill '${name}'`);
  },
};
