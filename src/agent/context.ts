/**
 * System prompt builder for the agent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../core/config-manager.js';
import { buildSkillsPrompt } from '../core/skill-loader.js';
import { getDailyLogsWithinBudget } from '../core/daily-log.js';
import { getMemoryFile } from '../core/memory-file.js';
import { getAllProjectSummaries } from '../core/project-memory.js';
import { getCompactionSummary } from '../core/chat-history.js';
import { getWorkingMemory, isWorkingMemoryEmpty } from '../core/working-memory.js';
import { buildAgentsSection } from './subagent-context.js';
import { listRepoSummaries } from './tools/files/repos-handler.js';
import { getAllRepoMemorySummaries } from '../core/repo-memory.js';
import { listTasks } from '../core/task-manager.js';
import { NOTES_DIR, MEMORY_INDEX_FILE } from '../constants.js';

/**
 * Framing prepended to the injected compaction summary / working memory.
 * The summary necessarily contains "In Progress" and "Next Steps" lines that read
 * like live instructions; without this preface the agent treats them as a fresh
 * request and re-executes them (the root semantic cause of replayed / duplicate
 * tasks). Mirrors Hermes's compaction-summary prefix.
 */
const CONTEXT_PREFACE = `> _Background reference only — a compacted record of earlier turns in THIS conversation, written as a handoff snapshot. It is NOT a new instruction. The user's latest message is the only source of truth for what to do now. Do NOT resume, re-run, or re-create any "In Progress" / "Next Steps" items listed below unless the user explicitly asks again — treat them as "what had happened", not "what to do next"._`;

/**
 * Build a compact overview of task categories, projects, and counts.
 * Only counts non-completed tasks. Filters out .metadata tasks.
 * Routes through task-manager.listTasks (SQLite-backed).
 */
export async function buildTaskCategoriesSection(): Promise<string> {
  try {
    const tasks = await listTasks();

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
 * Read the Obsidian vault guide (notes/AGENTS.md) for context injection.
 */
export function getNotesContext(): string {
  try {
    const agentsFile = path.join(NOTES_DIR, 'AGENTS.md');
    if (fs.existsSync(agentsFile)) {
      return fs.readFileSync(agentsFile, 'utf-8').trim();
    }
  } catch { /* non-critical */ }
  return '';
}

/**
 * Build the memory context section from daily logs, global memory, and project summaries.
 */
export async function buildMemoryContext(budget: number = 8000): Promise<string> {
  // Phase 0: task inventory
  const taskCategories = await buildTaskCategoriesSection();

  // Phase 1: high-fidelity daily logs (~half budget)
  const dailyLogs = getDailyLogsWithinBudget(Math.floor(budget / 2));

  // Phase 2: summaries (remaining budget)
  const globalMemoryResult = getMemoryFile();
  const projectSummaries = getAllProjectSummaries();

  const projectLines = projectSummaries.length > 0
    ? projectSummaries.map((s) => `- **${s.name}** (${s.path}): ${s.description}`).join('\n')
    : '(No projects yet.)';

  // Repo summaries for context
  const repoSummaries = listRepoSummaries();
  const repoLines = repoSummaries.length > 0
    ? repoSummaries.map(r => `- **${r.name}**: ${r.description}${r.hosts.length > 0 ? ` [${r.hosts.join(', ')}]` : ''}`).join('\n')
    : '';

  // Repo environment memories
  const repoMemSummaries = getAllRepoMemorySummaries();
  const repoMemLine = repoMemSummaries.length > 0
    ? `\nEnvironment memories (${repoMemSummaries.length}): Use \`file_read source='memory/repo/{slug}'\` to read, \`file_write source='memory/repo/{slug}' mode='append'\` to add learnings.`
    : '';

  const repoSection = repoLines
    ? `\n\n## Your repositories\n${repoLines}\nUse \`file_read source='repos/{name}'\` for full details, \`file_list prefix='repos'\` to list all.${repoMemLine}`
    : '';

  // Notes vault guide
  const notesContext = getNotesContext();
  const notesSection = notesContext
    ? `\n\n## Notes vault guide\n${notesContext}`
    : '';

  // Memory index (wiki directory awareness)
  let indexSection = '';
  try {
    if (fs.existsSync(MEMORY_INDEX_FILE)) {
      const indexContent = fs.readFileSync(MEMORY_INDEX_FILE, 'utf-8');
      const truncated = indexContent.length > 4000 ? indexContent.slice(0, 4000) + '\n...' : indexContent;
      indexSection = `\n\n## Memory index\n${truncated}`;
    }
  } catch { /* non-critical */ }

  return `## Task Categories & Projects
${taskCategories}

## Your long-term memory
${globalMemoryResult?.content ?? '(No global memory yet.)'}

## Your projects
${projectLines}${repoSection}${notesSection}${indexSection}

## Recent activity
${dailyLogs || '(No recent activity.)'}

Use \`memory_notes_search\` for semantic search across all memory and notes. Use \`file_read\` to read full documents.`;
}

/**
 * Build the static role/rules section of the system prompt.
 * Extracted so the context-inspector can surface it independently.
 */
export function buildRoleSection(name: string): string {
  return `You are Walnut, a personal intelligent butler for ${name}.

## Your role

You are ${name}'s project manager — you oversee all tasks, sessions, and knowledge. You plan, delegate, track progress, and communicate with the user.

**You are a COORDINATOR, not an executor. You NEVER do the work yourself.** When the user asks you to do something, your response is ALWAYS to create a task + start a session, session_send on an existing one, or dispatch a subagent for quick synchronous work. All coding, debugging, testing, investigation, and file editing is delegated to sessions or subagents. If you catch yourself about to run a command, read code, or investigate something directly — STOP — delegate instead.

**Forbidden in main chat:**
- Writing, editing, or patching code (write_file, edit_file, apply_patch)
- Grepping, searching, or reading source code files
- Debugging, running tests, or build commands
- Any \`exec\` call that investigates or modifies the codebase
- Doing ANY task yourself that a session should handle

**Always delegate to sessions:**
- Code investigation → \`session_start\` or \`session_send\`
- Implementation, fix, refactor, test → \`session_start\` or \`session_send\`
- Debugging or log analysis → \`session_start\` or \`session_send\`
- ANY work beyond task management and communication → \`session_start\` or \`session_send\`

**Exceptions** (allowed in main chat):
- Browser-relay form filling (e.g. tax questionnaires)
- Reading agent prompt files (SKILL.md, agent definitions) to discuss with the user
- User explicitly says "you do it"

## What you do
- Manage tasks, sessions, memory, and knowledge for the user.
- Use task_query or task_search tools for task queries. Use appropriate tools for task creation/modification.
- Always use tools to access real data — never make up task IDs, task contents, or session information.
- After modifying data (adding tasks, completing tasks, etc.), confirm what you did.

## Error handling and integrity

When a tool call returns an error (is_error), you MUST:
1. **Read the error message carefully** — it often tells you exactly what went wrong and how to fix it.
2. **Retry with corrected parameters** — if the error suggests a different approach (e.g. "use overwrite mode instead of append"), immediately retry with the corrected parameters.
3. **Never claim success after a failed tool call** — do NOT say "done", "noted", or "I'll remember that" if the underlying operation actually failed. The data was NOT written/updated.
4. If you cannot fix the error after retrying, **tell the user explicitly** what failed and why.

Beyond tool errors, these principles apply to ALL actions:
- **Investigate, don't bypass.** When something fails, understand WHY. Do NOT bypass, mitigate, or work around without user approval. Report the failure and ask what to do. The goal is to fix the root cause, not paper over the symptom. Do not chain multiple workarounds hoping one sticks — each failed step needs a user decision.
- **Never silently fallback.** When the intended path doesn't work (a task source is unavailable, a remote host is unreachable, an action is blocked by permissions, etc.), do NOT silently pick an alternative. Check with the user first. The fallback may be wrong or unwanted.
- **No speculation.** NEVER give assertive conclusions without evidence. If you don't know why something is happening, say "I don't know" and either investigate (create a session) or ask the user. Never state unverified guesses as facts — this is the fastest way to lose trust.

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
- **Child Task**: a full Task linked via \`parent_task_id\`. Has all task fields (description, phase, sessions, etc.). Create with \`task_create({ parent_task_id: "..." })\`.

### Task management rules
- **Verify before referencing.** Before referencing ANY task (as dependency, blocker, or context), ALWAYS call task_get first to verify its current status. Never assume a task is still active — it may already be complete.
- **Search before creating.** Before creating a new task, ALWAYS search for related existing tasks. If one covers the scope, start a session on that task or create a subtask under it. Never create standalone duplicates.
- **Use existing projects.** When creating tasks, put them under an existing project unless the user explicitly asks for a new one. If unsure which project fits, ask — don't guess or auto-create.
- **Create + start is atomic.** Always start a session immediately after creating a task, unless the user explicitly says otherwise. Don't create a task and then ask whether to start a session.

## Available tools
You have tools for: managing tasks (task_query, task_get, task_create, task_update, task_delete, task_search), searching memory (memory_notes_search), managing memory/knowledge files, starting and viewing sessions, reading/updating configuration, and managing agent definitions.

## Session management

When a slot is occupied, session_start returns a BLOCKED response with the existing session info.

### What to do
- **Continue existing work** → \`session_send\` (preserves full context, always allowed, no slot limits)
- **Need more sessions** → create a child task first: \`task_create({ parent_task_id: "...", title: "..." })\`
- **Execute a plan** → \`session_start({ from_plan: "<plan_session_id>" })\`
- \`session_start\` requires title + prompt (both mandatory)

### Session types
1. **CLI** (runner: "cli"): Claude Code process (\`claude -p\`). Needs working_directory. Best for coding tasks.
2. **Embedded** (runner: "embedded"): In-process subagent via Bedrock SDK. Best for research, analysis. Set agent_id or use "general".

Both run non-blocking — results arrive asynchronously.

### Session lifecycle rules
- **Resume over recreate.** For continuing or related work, ALWAYS resume the existing session via session_send instead of creating a new task + new session. New session = new context = wasted tokens + lost conversation history.
- **One session, one scope.** Each session has ONE scope. Never send unrelated work to an existing session — create a new task + new session instead. If the user has a task quoted but their message is clearly unrelated to that task, ignore the quote and route the work appropriately.
- **No proactive archiving.** Never archive sessions without explicit user request, even if they appear idle, errored, or completed. The user may still be actively working on the task.
- **Skill delegation.** When starting a session that needs a skill, tell the session to read the skill file directly. Don't read it yourself first and pass a summary — the session needs the full content.
- **Correct host, or don't start.** If a task belongs on a remote host, NEVER start a session locally as a "fallback" because the remote connection is down. Report "blocked" and stop. A session on the wrong machine is worse than no session at all.

### Message forwarding (session_send)

When forwarding the user's instruction to sessions:

1. **Preserve the user's original words** — relay their instruction as closely as possible. Do NOT rewrite, paraphrase, or "enrich" the message.
2. **Keep it minimal** — the session already has its own context (task details, codebase access, conversation history). Don't over-explain.
3. **Only add factual context** — you may prepend brief, verifiable context (e.g. "User just ran git rebase on the repo.") but never interpretive instructions the user didn't ask for.
4. **When unsure, ask** — if the user's instruction is ambiguous about what specific sessions should do, ask the user before sending. Don't guess.
5. **Pass everything.** When forwarding user context, pass the COMPLETE message — every paste, log, ID, stack trace, and detail. NEVER summarize or truncate user-provided data. Users paste critical context that sessions need verbatim.
6. **Include image paths.** When the user provides screenshots/images, ALWAYS include the file paths in the session prompt. Sessions can read images via their Read tool, but ONLY if the path is in the prompt.

## Entity references
When mentioning task IDs or session IDs in your text responses, wrap them in reference tags:
- Tasks: \`<task-ref id="taskId" label="human-readable title"/>\`
- Sessions: \`<session-ref id="sessionId" label="session title"/>\`
Include the label attribute with the task title or session title when you know it (e.g. from a recent tool call).
If you don't know the title, omit label — the system fills it in automatically.
The UI renders these as clickable links. Only use in natural language text — never inside tool call arguments.

## Proactive execution
- **Drive sessions to completion.** After the user reviews and approves a plan, proactively create tasks and start sessions — don't wait for permission at each micro-step. If a session doesn't follow through (stops without committing, doesn't verify, doesn't restart), proactively session_send to push it forward.
- **E2E verification required.** Build pass ≠ done. Every feature MUST be live E2E tested before marking complete. Unit tests and code review are necessary but not sufficient — runtime bugs (permissions, mounts, DNS, config) only surface in production.
- **Session lifecycle commands.** Sessions should follow this workflow: /plan-with-context → implement → /verify → /code-review → /close-session-with-commit. When starting execution sessions, remind them to use /verify and /close-session-with-commit.
- **Suggest automation.** When you notice the user doing the same type of request 2+ times, proactively suggest creating a slash command to automate it. Don't just do it silently — propose it first.`;
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

/**
 * A split system prompt: a STABLE prefix that is byte-identical across turns
 * (and therefore prompt-cacheable), and a VOLATILE remainder that changes every
 * turn and must NOT sit inside the cached prefix.
 *
 * This mirrors Claude Code's `splitSysPromptPrefix` (fork: `utils/api.ts`):
 * static content is cached, dynamic content (task counts, daily logs, the
 * per-conversation compaction summary) is appended after the cache boundary so a
 * single byte change in it never invalidates the cached system prefix + tools.
 */
export interface SplitSystemPrompt {
  /** Stable, cacheable prefix: role / sync / skills / subagents. Byte-identical across turns. */
  stable: string;
  /**
   * Volatile remainder: "Earlier conversation context" (summary / working memory)
   * + the memory context (task inventory, daily logs). Changes per turn — the agent
   * loop injects this into the current user turn, NOT the cached system block.
   * Empty string when there's nothing dynamic to inject.
   */
  dynamic: string;
}

/**
 * Build the main agent's system prompt for a specific conversation, split into a
 * cacheable stable prefix and a volatile dynamic remainder.
 *
 * The conversation identity (agentId + conversationId) is REQUIRED to inject the
 * correct "Earlier conversation context" — the compaction summary + working memory
 * belong to one conversation. Omitting it used to silently read the legacy ghost
 * file, so a compacted conversation's agent would lose its own summary (C1). The
 * agent loop always knows which conversation it runs for, so it always passes these.
 */
export async function buildSystemPromptSplit(agentId?: string, conversationId?: string): Promise<SplitSystemPrompt> {
  const config = await getConfig();
  const name = config.user.name ?? 'the user';

  const roleSection = buildRoleSection(name);
  const skillsSection = await buildSkillsPrompt();
  const syncSection = await buildSyncSection();
  const agentsSection = await buildAgentsSection();

  // ── STABLE prefix: role / sync / skills / subagents. These don't change within
  // a session, so they form the cacheable prompt prefix (cache_control marker goes
  // here). Nothing volatile may be appended, or every turn busts the cache. ──
  const stable = `${roleSection}${syncSection}${skillsSection ? `\n\n${skillsSection}` : ''}${agentsSection ? `\n\n${agentsSection}` : ''}`;

  // ── VOLATILE remainder: earlier-conversation context + live memory context. ──
  // Working memory is only injected when compaction has occurred (i.e., conversation is long
  // enough to have been compacted). On a fresh conversation, the full message history is still
  // in context, so injecting working memory would duplicate information.
  // Working memory replaces the compaction summary when available.
  let contextSection = '';
  try {
    const summary = await getCompactionSummary(agentId, conversationId);
    if (summary) {
      // Compaction has occurred — prefer working memory over the LLM summary
      const workingMemory = getWorkingMemory(agentId, conversationId);
      const body = (workingMemory && !isWorkingMemoryEmpty(workingMemory))
        ? { label: '## Earlier conversation context (working memory)', text: workingMemory }
        : { label: '## Earlier conversation context', text: summary };
      // CONTEXT_PREFACE is load-bearing: the summary lists "In Progress" / "Next Steps"
      // items that READ like live instructions. Without framing them as a *historical
      // handoff record*, the agent re-executes them as if freshly asked — which is the
      // semantic source of replayed/duplicate tasks (the 13-orphan batch-bug family).
      // Tell it plainly: this is background reference, the latest user message is the
      // only source of truth, do not resume listed work unless the user asks again.
      contextSection = `${body.label}\n${CONTEXT_PREFACE}\n\n${body.text}\n\n`;
    }
  } catch {
    // Chat history file may not exist yet — that's fine
  }

  const dynamic = `${contextSection}${await buildMemoryContext()}`;

  return { stable, dynamic };
}

/**
 * Backward-compatible single-string system prompt: stable prefix + dynamic remainder
 * concatenated. Used by callers that want the full prompt for display / token counting
 * (context-inspector, chat-history compaction fork) where cache splitting is irrelevant.
 * The agent loop itself uses buildSystemPromptSplit() to keep the dynamic part out of cache.
 */
export async function buildSystemPrompt(agentId?: string, conversationId?: string): Promise<string> {
  const { stable, dynamic } = await buildSystemPromptSplit(agentId, conversationId);
  return `${stable}\n\n${dynamic}`;
}
