/**
 * Skill bridge: loads skills (workspace / walnut / claude / builtin / plugin-registered
 * — every source the server-side skill loader discovers) into the frontend command
 * registry so the main-chat "/" palette shows skills alongside commands.
 *
 * Selecting a skill sends the agent an instruction to apply that skill —
 * the agent already has the skill list in its system prompt, so naming it
 * is enough for it to load and follow the SKILL.md.
 *
 * Registered under the 'skill' owner, the lowest-priority tier: a command of the same
 * name always wins, and refreshing skills can never disturb a command.
 */
import { registerOwned, removeOwner } from './registry.js';
import { fetchSkills } from '@/api/skills';
import type { SlashCommand } from './types.js';

export async function loadSkillCommands(): Promise<void> {
  try {
    const skills = await fetchSkills();

    for (const skill of skills) {
      if (!skill.eligible || !skill.enabled) continue;

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
      registerOwned('skill', cmd);
    }
  } catch {
    // Server may not be up yet — palette just shows commands only.
  }
}

export async function refreshSkillCommands(): Promise<void> {
  removeOwner('skill');
  await loadSkillCommands();
}
