import type { SlashCommand } from './types.js';

const commands = new Map<string, SlashCommand>();

export function register(cmd: SlashCommand): void {
  if (commands.has(cmd.name)) {
    console.warn(`[commands] duplicate registration for "/${cmd.name}", overwriting`);
  }
  commands.set(cmd.name, cmd);
}

export function unregister(name: string): void {
  commands.delete(name);
}

export function getCommand(name: string): SlashCommand | undefined {
  return commands.get(name);
}

export function listCommands(): SlashCommand[] {
  return Array.from(commands.values());
}

export function searchCommands(query: string): SlashCommand[] {
  if (!query) return listCommands();
  const q = query.toLowerCase();
  return listCommands().filter(
    (cmd) => cmd.name.includes(q) || cmd.description.toLowerCase().includes(q),
  );
}
