/**
 * Slash-command registry — owner-scoped, with a fixed priority order.
 *
 * Three owners, highest priority first:
 *   core      — hardcoded frontend commands (/compact, /session, /task, /help …)
 *   markdown  — server-stored commands: user .md, plugin-registered, shipped builtin
 *   skill     — SKILL.md entries surfaced in the palette
 *
 * Two rules this shape exists to guarantee:
 *   1. A refresh of ONE owner can only remove that owner's entries. The old registry
 *      was a single name→command map and `refreshMarkdownCommands()` deleted every
 *      command whose source wasn't 'hardcoded' or 'skill' — which silently unregistered
 *      /compact, /session and /task (source 'control') and never put them back.
 *   2. A lower-priority owner never shadows a higher one. Commands always beat skills,
 *      whatever order the two bridges happen to finish loading in.
 */
import type { SlashCommand } from './types.js';

/** Owners in priority order — the first owner holding a name wins it. */
export const COMMAND_OWNERS = ['core', 'markdown', 'skill'] as const;

export type CommandOwner = (typeof COMMAND_OWNERS)[number];

/** One bucket per owner. Map keeps insertion order, so listing stays stable. */
const byOwner = new Map<CommandOwner, Map<string, SlashCommand>>(
  COMMAND_OWNERS.map((owner) => [owner, new Map<string, SlashCommand>()]),
);

function bucket(owner: CommandOwner): Map<string, SlashCommand> {
  let commands = byOwner.get(owner);
  if (!commands) {
    commands = new Map<string, SlashCommand>();
    byOwner.set(owner, commands);
  }
  return commands;
}

/** Map a command's declared source onto the owner that should hold it. */
function ownerForSource(source?: SlashCommand['source']): CommandOwner {
  if (source === 'skill') return 'skill';
  if (source === 'hardcoded' || source === 'control') return 'core';
  return 'markdown';
}

export function registerOwned(owner: CommandOwner, cmd: SlashCommand): void {
  const commands = bucket(owner);
  if (commands.has(cmd.name)) {
    console.warn(`[commands] duplicate registration for "/${cmd.name}" in "${owner}", overwriting`);
  }
  commands.set(cmd.name, cmd);
}

/** Drop one command from ONE owner. Other owners keep their entry of that name. */
export function removeOwned(owner: CommandOwner, name: string): boolean {
  return bucket(owner).delete(name);
}

/** Drop everything an owner registered. Returns how many entries went away. */
export function removeOwner(owner: CommandOwner): number {
  const commands = bucket(owner);
  const count = commands.size;
  commands.clear();
  return count;
}

export function getCommand(name: string): SlashCommand | undefined {
  for (const owner of COMMAND_OWNERS) {
    const found = byOwner.get(owner)?.get(name);
    if (found) return found;
  }
  return undefined;
}

/** Winning command per name, in owner-priority then registration order. */
export function listCommands(): SlashCommand[] {
  const winners: SlashCommand[] = [];
  const claimed = new Set<string>();
  for (const owner of COMMAND_OWNERS) {
    for (const cmd of byOwner.get(owner)?.values() ?? []) {
      if (claimed.has(cmd.name)) continue;
      claimed.add(cmd.name);
      winners.push(cmd);
    }
  }
  return winners;
}

export function searchCommands(query: string): SlashCommand[] {
  if (!query) return listCommands();
  const q = query.toLowerCase();
  return listCommands().filter(
    (cmd) => cmd.name.includes(q) || cmd.description.toLowerCase().includes(q),
  );
}

// ── Legacy, owner-inferring API ───────────────────────────────────────
// Kept so existing call sites (and any plugin code) keep working; new code should
// name its owner explicitly.

export function register(cmd: SlashCommand): void {
  registerOwned(ownerForSource(cmd.source), cmd);
}

/** Remove a name from EVERY owner — the old single-map semantics. */
export function unregister(name: string): void {
  for (const owner of COMMAND_OWNERS) bucket(owner).delete(name);
}
