export type CommandType = 'frontend' | 'agent';

export interface SlashCommand {
  name: string;
  description: string;
  type: CommandType;
  /** Where this command comes from: hardcoded, App Registry, markdown, Plugin, control, or Skill. */
  source?: 'hardcoded' | 'app' | 'builtin' | 'user' | 'plugin' | 'control' | 'skill';
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
  /** Active agent the command was invoked for (defaults to 'general' when omitted). */
  agentId?: string;
  /** Active conversation the command was invoked for — required so commands like
   * /compact act on the conversation the user is looking at, not the legacy file. */
  conversationId?: string;
}
