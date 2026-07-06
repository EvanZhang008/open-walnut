/**
 * Skill bridge: loads skills (workspace / walnut / claude / builtin — every
 * source the server-side skill loader discovers) into the frontend command
 * registry so the main-chat "/" palette shows skills alongside commands.
 *
 * Selecting a skill sends the agent an instruction to apply that skill —
 * the agent already has the skill list in its system prompt, so naming it
 * is enough for it to load and follow the SKILL.md.
 */
import { register, unregister, listCommands } from './registry.js';
import { fetchSkills } from '@/api/skills';
import type { SlashCommand } from './types.js';

/** Track what we registered so refresh can cleanly unregister only skills. */
const registeredSkillNames = new Set<string>();

export async function loadSkillCommands(): Promise<void> {
  try {
    const skills = await fetchSkills();
    const existing = new Set(listCommands().map((c) => c.name));

    for (const skill of skills) {
      if (!skill.eligible || !skill.enabled) continue;
      // Commands win on name collisions — a skill never shadows /help etc.
      if (existing.has(skill.name) && !registeredSkillNames.has(skill.name)) continue;

      const cmd: SlashCommand = {
        name: skill.name,
        description: skill.description || `Apply the ${skill.name} skill`,
        type: 'agent',
        source: 'skill',
        execute: (ctx) => {
          const parts = [`Apply your "${skill.name}" skill (${skill.location}) now.`];
          if (ctx.args) parts.push(`Request: ${ctx.args}`);
          ctx.sendMessage(parts.join(' '));
        },
      };
      register(cmd);
      registeredSkillNames.add(skill.name);
    }
  } catch {
    // Server may not be up yet — palette just shows commands only.
  }
}

export async function refreshSkillCommands(): Promise<void> {
  for (const name of registeredSkillNames) unregister(name);
  registeredSkillNames.clear();
  await loadSkillCommands();
}
