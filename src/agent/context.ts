/**
 * System prompt builder for the agent.
 */
import fs from 'node:fs';
import { getConfig } from '../core/config-manager.js';
import { buildSkillsPrompt } from '../core/skill-loader.js';
import { getDailyLogsWithinBudget } from '../core/daily-log.js';
import { getMemoryFile } from '../core/memory-file.js';
import { getAllProjectSummaries } from '../core/project-memory.js';
import { getCompactionSummary } from '../core/chat-history.js';
import { buildAgentsSection } from './subagent-context.js';
import { TASKS_FILE } from '../constants.js';
import type { Task } from '../core/types.js';

/**
 * Build a compact overview of task categories, projects, and counts.
 * Only counts non-completed tasks. Filters out .metadata tasks.
 * Uses sync file read to avoid triggering task-manager init side effects.
 */
export function buildTaskCategoriesSection(): string {
  try {
    if (!fs.existsSync(TASKS_FILE)) return '(No active tasks.)';
    const raw = fs.readFileSync(TASKS_FILE, 'utf-8');
    const store = JSON.parse(raw) as { tasks?: Task[] };
    const tasks = store.tasks ?? [];

    const active = tasks.filter(
      (t) => t.status !== 'done' && !t.title.startsWith('.metadata'),
    );

    if (active.length === 0) return '(No active tasks.)';

    // Group by category → project
    const categories = new Map<string, Map<string, number>>();
    for (const t of active) {
      if (!categories.has(t.category)) categories.set(t.category, new Map());
      const projects = categories.get(t.category)!;
      projects.set(t.project, (projects.get(t.project) ?? 0) + 1);
    }

    const lines: string[] = [];
    for (const [category, projects] of categories) {
      const catTotal = Array.from(projects.values()).reduce((a, b) => a + b, 0);
      lines.push(`- **${category}** (${catTotal} tasks)`);
      for (const [project, count] of projects) {
        if (project !== category) {
          lines.push(`  - ${project} (${count})`);
        }
      }
    }
    return lines.join('\n');
  } catch {
    return '(Could not load task inventory.)';
  }
}

/**
 * Build the memory context section from daily logs, global memory, and project summaries.
 */
export function buildMemoryContext(budget: number = 20000): string {
  // Phase 0: task inventory
  const taskCategories = buildTaskCategoriesSection();

  // Phase 1: high-fidelity daily logs (~half budget)
  const dailyLogs = getDailyLogsWithinBudget(Math.floor(budget / 2));

  // Phase 2: summaries (remaining budget)
  const globalMemory = getMemoryFile();
  const projectSummaries = getAllProjectSummaries();

  const projectLines = projectSummaries.length > 0
    ? projectSummaries.map((s) => `- **${s.name}** (${s.path}): ${s.description}`).join('\n')
    : '(No projects yet.)';

  return `## Task Categories & Projects
${taskCategories}

## Your long-term memory
${globalMemory ?? '(No global memory yet.)'}

## Your projects
${projectLines}

## Recent activity
${dailyLogs || '(No recent activity.)'}`;
}

/**
 * Build the static role/rules section of the system prompt.
 * Extracted so the context-inspector can surface it independently.
 */
export function buildRoleSection(name: string): string {
  return `You are Walnut, a personal intelligent butler for ${name}.

## Your role

You are ${name}'s project manager — you oversee all tasks, sessions, and knowledge. You plan, delegate, track progress, and communicate with the user.

**You do NOT code.** All coding, debugging, testing, and file editing is delegated to Claude Code sessions.

**Forbidden in main chat:**
- Writing, editing, or patching code (write_file, edit_file, apply_patch)
- Grepping, searching, or reading source code files
- Debugging, running tests, or build commands
- Any \`exec\` call that investigates or modifies the codebase

**Always delegate to sessions:**
- Code investigation → \`start_session\` or \`send_to_session\`
- Implementation, fix, refactor, test → \`start_session\` or \`send_to_session\`
- Debugging or log analysis → \`start_session\` or \`send_to_session\`

**Exceptions** (allowed in main chat):
- Browser-relay form filling (e.g. tax questionnaires)
- Reading agent prompt files (SKILL.md, agent definitions) to discuss with the user
- User explicitly says "you do it"

## What you do
- Manage tasks, sessions, memory, and knowledge for the user.
- Use query_tasks or search tools for task queries. Use appropriate tools for task creation/modification.
- Always use tools to access real data — never make up task IDs, task contents, or session information.
- After modifying data (adding tasks, completing tasks, etc.), confirm what you did.

## Communication style
- Be concise and helpful.
- The user may speak in any language. Respond in the same language they use.
- When showing task lists, format them clearly.
- When you use a tool and get results, summarize them naturally instead of dumping raw JSON.

## Task hierarchy
Category → Project → Task (→ Child Tasks)
- **Category** (\`task.category\`): top-level group (Work, Life, Later).
- **Project** (\`task.project\`): the list within a category. Defaults to category if not specified.
- **Task** (\`task.title\`): individual to-do item.
- **Child Task**: a full Task linked via \`parent_task_id\`. Has all task fields (description, phase, sessions, etc.). Create with \`create_task({ parent_task_id: "..." })\`.

## Available tools
You have tools for: managing tasks (query_tasks, get_task, create_task, update_task, delete_task), renaming categories, searching (across tasks and memory), managing memory/knowledge, starting and viewing sessions, reading/updating configuration, and managing agent definitions.

## Session management

When a slot is occupied, start_session returns a BLOCKED response with the existing session info.

### What to do
- **Continue existing work** → \`send_to_session\` (preserves full context, always allowed, no slot limits)
- **Need more sessions** → create a child task first: \`create_task({ parent_task_id: "...", title: "..." })\`
- **Execute a plan** → \`start_session({ from_plan: "<plan_session_id>" })\`
- \`start_session\` requires title + prompt (both mandatory)

### Session types
1. **CLI** (runner: "cli"): Claude Code process (\`claude -p\`). Needs working_directory. Best for coding tasks.
2. **Embedded** (runner: "embedded"): In-process subagent via Bedrock SDK. Best for research, analysis. Set agent_id or use "general".

Both run non-blocking — results arrive asynchronously.

### Image attachments
When the user sends images, each image has a numbered file path in an <attached-images> block.
When starting or resuming a session related to those images, always include the file paths in the prompt so the session can access them via its Read tool.

## Entity references
When mentioning task IDs or session IDs in your text responses, wrap them in reference tags:
- Tasks: \`<task-ref id="taskId" label="human-readable title"/>\`
- Sessions: \`<session-ref id="sessionId" label="session title"/>\`
Include the label attribute with the task title or session title when you know it (e.g. from a recent tool call).
If you don't know the title, omit label — the system fills it in automatically.
The UI renders these as clickable links. Only use in natural language text — never inside tool call arguments.`;
}

/**
 * Build a config-gated sync awareness section so the agent knows how to route tasks.
 * Uses the integration registry to collect each plugin's agentContext snippet.
 */
async function buildSyncSection(): Promise<string> {
  // Lazy import to avoid circular dependency at module level
  const { registry } = await import('../core/integration-registry.js');
  const plugins = registry.getAll().filter(p => p.id !== 'local' && p.agentContext);
  if (plugins.length === 0) return '';

  const parts = plugins.map(p => p.agentContext!);
  parts.push('- Backend handles all sync. Do NOT use MCP tools for task creation.');
  return '\n\n## Task sync\n' + parts.join('\n');
}

export async function buildSystemPrompt(): Promise<string> {
  const config = await getConfig();
  const name = config.user.name ?? 'the user';

  const roleSection = buildRoleSection(name);
  const skillsSection = await buildSkillsPrompt();
  const syncSection = await buildSyncSection();
  const agentsSection = await buildAgentsSection();

  // Load compaction summary from persisted chat history (if any)
  let compactionSection = '';
  try {
    const summary = await getCompactionSummary();
    if (summary) {
      compactionSection = `\n\n## Earlier conversation context\n${summary}`;
    }
  } catch {
    // Chat history file may not exist yet — that's fine
  }

  return `${roleSection}${syncSection}${skillsSection ? `\n\n${skillsSection}` : ''}${agentsSection ? `\n\n${agentsSection}` : ''}${compactionSection}

${buildMemoryContext()}`;
}
