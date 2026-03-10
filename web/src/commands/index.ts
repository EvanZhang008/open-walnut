import { register } from './registry.js';
import { compactCommand } from './compact.js';
import { helpCommand } from './help.js';
import { checkTasksCommand } from './check-tasks.js';
import { planCommand } from './plan.js';
import { sessionCommand } from './session.js';
import { sessionsCommand } from './sessions.js';
import { tasksCommand } from './tasks.js';
import { loadMarkdownCommands } from './markdown-bridge.js';

// Register hardcoded commands (highest priority — never overridden)
register({ ...compactCommand, source: 'hardcoded' });
register({ ...helpCommand, source: 'hardcoded' });
register({ ...checkTasksCommand, source: 'hardcoded' });
register({ ...planCommand, source: 'hardcoded' });
register({ ...sessionCommand, source: 'hardcoded' });
register({ ...sessionsCommand, source: 'hardcoded' });
register({ ...tasksCommand, source: 'hardcoded' });

// Load markdown-based commands from the server (async, non-blocking)
loadMarkdownCommands();

export { getCommand, listCommands, searchCommands } from './registry.js';
export { refreshMarkdownCommands } from './markdown-bridge.js';
export type { SlashCommand, CommandContext, CommandType } from './types.js';
