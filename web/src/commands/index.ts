import { registerOwned } from './registry.js';
import { compactCommand } from './compact.js';
import { helpCommand } from './help.js';
import { checkTasksCommand } from './check-tasks.js';
import { planCommand } from './plan.js';
import { sessionCommand } from './session.js';
import { taskCommand } from './task.js';
import { tasksCommand } from './tasks.js';
import { loadMarkdownCommands } from './markdown-bridge.js';
import { loadSkillCommands } from './skill-bridge.js';

// Hardcoded commands own the 'core' tier — the highest priority. Commands with their
// own source (e.g. 'control') keep it for palette labelling; others get 'hardcoded'.
registerOwned('core', { ...compactCommand });
registerOwned('core', { ...helpCommand, source: 'hardcoded' });
registerOwned('core', { ...checkTasksCommand, source: 'hardcoded' });
registerOwned('core', { ...planCommand, source: 'hardcoded' });
registerOwned('core', { ...sessionCommand });
registerOwned('core', { ...taskCommand });
registerOwned('core', { ...tasksCommand, source: 'hardcoded' });

// Load markdown-based commands, then skills (async, non-blocking). Owner tiers decide
// name collisions now, so load order is no longer load-bearing.
loadMarkdownCommands().then(() => loadSkillCommands());

export { getCommand, listCommands, searchCommands } from './registry.js';
export { refreshMarkdownCommands } from './markdown-bridge.js';
export { refreshSkillCommands } from './skill-bridge.js';
export type { SlashCommand, CommandContext, CommandType } from './types.js';
