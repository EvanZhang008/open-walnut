/** Slash command system types for the Global Notes editor */

export interface NoteSlashCommand {
  name: string;
  description: string;
  icon: string;
  /** Action key — determines which sub-panel to open */
  action: string;
}

export interface SlashRange {
  from: number;
  to: number;
}

export type SlashCommandState =
  | { phase: 'closed' }
  | { phase: 'commands'; range: SlashRange; query: string };

export const NOTE_SLASH_COMMANDS: NoteSlashCommand[] = [
  { name: 'task', description: 'Insert a task reference', icon: '\u{1F4CB}', action: 'task-search' },
];
