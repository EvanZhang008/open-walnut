import { register } from './registry.js';
import { compactCommand } from './compact.js';
import { helpCommand } from './help.js';
import { checkTasksCommand } from './check-tasks.js';
import { planCommand } from './plan.js';
import { sessionCommand } from './session.js';
import { sessionsCommand } from './sessions.js';
import { tasksCommand } from './tasks.js';
import { loadMarkdownCommands } from './markdown-bridge.js';
import { loadSkillCommands } from './skill-bridge.js';

// Register hardcoded commands (highest priority — never overridden)
// Commands with their own source (e.g. 'control') keep it; others get 'hardcoded'
register({ ...compactCommand });
register({ ...helpCommand, source: 'hardcoded' });
register({ ...checkTasksCommand, source: 'hardcoded' });
register({ ...planCommand, source: 'hardcoded' });
register({ ...sessionCommand });
register({ ...sessionsCommand, source: 'hardcoded' });
register({ ...tasksCommand, source: 'hardcoded' });

// Load markdown-based commands, then skills (async, non-blocking).
// Order matters: commands register first so they win name collisions.
loadMarkdownCommands().then(() => loadSkillCommands());

export { getCommand, listCommands, searchCommands } from './registry.js';
export { refreshMarkdownCommands } from './markdown-bridge.js';
export { refreshSkillCommands } from './skill-bridge.js';
export type { SlashCommand, CommandContext, CommandType } from './types.js';
