export type CommandType = 'frontend' | 'agent';

export interface SlashCommand {
  name: string;
  description: string;
  type: CommandType;
  /** Where this command comes from: hardcoded (frontend), builtin (.md shipped), user (.md user-created) */
  source?: 'hardcoded' | 'builtin' | 'user';
  execute: (ctx: CommandContext) => void | Promise<void>;
}

export interface CommandContext {
  /** Send a message through the main chat (agent or session) */
  sendMessage: (text: string) => void;
  /** Clear chat history */
  clearMessages: () => void;
  /** Insert a local-only system message into the chat UI */
  addLocalMessage: (content: string) => void;
  /** Navigate to a route within the app */
  navigate: (path: string) => void;
  /** Arguments passed after the command name (e.g. "/plan redesign auth" → "redesign auth") */
  args?: string;
}
