/**
 * System prompt builder for the agent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../core/config-manager.js';
import { buildSkillsPrompt } from '../core/skill-loader.js';
import { getDailyLogsWithinBudget, estimateTokens } from '../core/daily-log.js';
import { getBoundedMemory, promptScope } from '../core/bounded-memory.js';
import { getCompactionSummary } from '../core/chat-history.js';
import { getWorkingMemory, isWorkingMemoryEmpty } from '../core/working-memory.js';
import { listRepoSummaries } from './tools/files/repos-handler.js';
import { getAllRepoMemorySummaries } from '../core/repo-memory.js';
import { listTasks, getStoreProjects } from '../core/task-manager.js';
import { buildTaskLedger } from '../core/task-ledger.js';
import { NOTES_DIR } from '../constants.js';

/**
 * Framing prepended to the injected compaction summary / working memory.
 * The summary necessarily contains "In Progress" and "Next Steps" lines that read
 * like live instructions; without this preface the agent treats them as a fresh
 * request and re-executes them (the root semantic cause of replayed / duplicate
 * tasks). Mirrors Hermes's compaction-summary prefix.
 */
const CONTEXT_PREFACE = `> _Background reference only — a compacted record of earlier turns in THIS conversation, written as a handoff snapshot. It is NOT a new instruction. The user's latest message is the only source of truth for what to do now. Do NOT resume, re-run, or re-create any "In Progress" / "Next Steps" items listed below unless the user explicitly asks again — treat them as "what had happened", not "what to do next". Your long-term memory and skills remain fully authoritative regardless of this compaction note._`;

/**
 * Build a flat overview of projects and their open task counts.
 * Only counts non-completed tasks. Filters out .metadata tasks.
 * Inbox (no project) is listed last so real projects lead.
 * Each line carries the registry source badge so the agent knows which
 * projects are provider-claimed (a task filed there syncs out).
 */
export async function buildTaskProjectsSection(): Promise<string> {
  try {
    const [tasks, registry] = await Promise.all([listTasks(), getStoreProjects()]);

    const active = tasks.filter(
      (t) => t.status !== 'done' && !t.title.startsWith('.metadata'),
    );

    if (active.length === 0) return '(No active tasks.)';

    // Count per project; '' = Inbox. Registry rows appear even with 0 open tasks
    // so the agent can still route work to a known-but-quiet project.
    const counts = new Map<string, number>();
    for (const name of Object.keys(registry)) counts.set(name, 0);
    for (const t of active) {
      const project = t.project || '';
      const key = project
        ? ([...counts.keys()].find((k) => k.toLowerCase() === project.toLowerCase()) ?? project)
        : '';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const inboxCount = counts.get('') ?? 0;
    counts.delete('');

    const lines = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => {
        const source = registry[name]?.source;
        const badge = source && source !== 'local' ? ` [${source}]` : '';
        return `- **${name}** (${count} tasks)${badge}`;
      });
    if (inboxCount > 0) lines.push(`- **Inbox** (${inboxCount} tasks) — no project`);
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
 *
 * `scope` (from beginMemoryPromptTurn) selects the FROZEN memory render pinned at
 * this turn's boundary, so every prompt build for one turn — the compaction
 * gate's estimate, the real payload, an interleaved background-review fork — sees
 * the same memory even if a write lands mid-turn. Omitted → reads live from disk
 * (unchanged pre-freeze behavior; see memory-prompt-snapshot.ts).
 */
export async function buildMemoryContext(budget: number = 8000, scope?: string): Promise<string> {
  // Phase 0: task inventory + recent-task ledger
  const taskProjects = await buildTaskProjectsSection();
  const taskLedger = await buildTaskLedger();

  // Phase 1: high-fidelity daily logs (~half budget)
  const dailyLogs = getDailyLogsWithinBudget(Math.floor(budget / 2));

  // Phase 2: summaries (remaining budget)
  // Global memory + user profile are BOUNDED stores ("## Title" entries).
  // renderForPrompt() prepends a usage header so the model always sees how full
  // each is — no truncation needed, the budget is enforced at write time.
  const globalMemoryBlock = getBoundedMemory().renderForPrompt(scope);
  const userProfileBlock = getBoundedMemory(undefined, 'user').renderForPrompt(scope);

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

  // memory/index.md retired (2026-07 unification): directory awareness now
  // comes from the skills index (buildSkillsPrompt) — no separate wiki index.

  // Ledger: scan-first answer surface for "which task did X?" — check it BEFORE
  // reaching for task_search. Sits in the dynamic segment (changes per turn).
  const ledgerSection = taskLedger
    ? `\n\n## Recent tasks (newest first — scan this before task_search when asked "which task did/does X")\n${taskLedger}`
    : '';

  const assembled = `## Projects
${taskProjects}${ledgerSection}

## User profile (who the user is — bounded, update via memory_manage target:user)
${userProfileBlock ?? '(No user profile yet. Save who the user is — identity, work, durable preferences — with memory_manage target:user.)'}

## Your long-term memory (behavior rules — bounded, update via memory_manage target:memory)
${globalMemoryBlock ?? '(No global memory yet. Save behavior rules with memory_manage.)'}${repoSection}${notesSection}

## Recent activity
${dailyLogs || '(No recent activity.)'}

Use \`memory_notes_search\` for semantic search across all memory and notes. Use \`file_read\` to read full documents.`;

  // `budget` USED TO BE ADVISORY, and only the daily-logs half honored it: asking
  // for 2000 returned 7069 tokens (3.5x over), asking for 8000 returned 9761.
  // Every other section ("bounded" stores, the task ledger, repo/notes guides) is
  // bounded at WRITE time, which bounds each store individually but never bounds
  // their SUM — so the block grew silently as stores filled up.
  //
  // Why that costs real money and latency: this whole block is the `dynamic`
  // segment, injected AFTER the prompt-cache breakpoint (deliberately — it changes
  // per turn, so caching it would bust the far larger stable prefix). Uncached
  // means it is re-billed as fresh input tokens on EVERY round-trip of EVERY turn,
  // and a tool-using turn is 2+ round-trips. Measured on this vault: 10,625
  // uncached tokens per round-trip, ~17,050 total uncached input.
  //
  // So the budget is now enforced as a real ceiling. Trimming happens at SECTION
  // granularity, dropping whole trailing sections lowest-value-first, because half
  // a markdown section is worse than no section (the model can still `file_read`
  // or `memory_notes_search` for anything dropped — nothing here is unreachable).
  return enforceContextBudget(assembled, budget);
}

/**
 * Trim an assembled context block to `budget` tokens by dropping whole trailing
 * sections, lowest-value-first, and appending a visible note about what was cut.
 *
 * Order is deliberate: "Recent activity" (daily logs) is the most re-readable via
 * `file_read`, so it goes first; identity/behavior rules go last because dropping
 * them changes how the agent BEHAVES rather than just what it knows.
 */
function enforceContextBudget(text: string, budget: number): string {
  if (estimateTokens(text) <= budget) return text;

  // Lowest value first. Each entry is the section heading as it appears above.
  //
  // "Recent activity" is FIRST for a measured reason: on this vault it was 3,895
  // of the ~10.6K tokens, and its content is raw daily work logs — the single most
  // re-readable thing here (`file_read` + `memory_notes_search` both reach it).
  // Identity/behavior rules are intentionally NOT droppable: losing them changes
  // how the agent behaves, not just what it knows.
  const DROP_ORDER = [
    '## Recent activity',
    '## Notes vault guide',
    '## Your repositories',
    '## Recent tasks',
  ];

  let out = text;
  const dropped: string[] = [];
  for (const heading of DROP_ORDER) {
    if (estimateTokens(out) <= budget) break;
    const start = out.indexOf(`\n${heading}`);
    if (start < 0) continue;
    // Find this section's END. CAREFUL: the bounded memory/user stores render
    // their OWN entries as `## Title` too, so "next `## `" is NOT a reliable
    // section boundary — it would stop at a store entry and leave the rest of the
    // dropped section behind (measured: a naive scan freed only 583 of 3895
    // tokens). Only the known top-level headings terminate a section.
    const TOP_LEVEL = [
      '\n## Projects',
      '\n## Recent tasks',
      '\n## User profile',
      '\n## Your long-term memory',
      '\n## Your repositories',
      '\n## Notes vault guide',
      '\n## Recent activity',
    ];
    let end = out.length;
    for (const marker of TOP_LEVEL) {
      const at = out.indexOf(marker, start + heading.length + 1);
      if (at > 0 && at < end) end = at;
    }
    out = out.slice(0, start) + out.slice(end);
    dropped.push(heading.replace('## ', ''));
  }

  if (dropped.length > 0) {
    // Tell the model what is missing so it knows to go fetch it rather than
    // assuming the omission means "none exist" — a silent drop reads as absence.
    out += `\n\n(Context budget: omitted ${dropped.join(', ')} — retrieve with \`memory_notes_search\` or \`file_read\` if needed.)`;
  }
  return out;
}

/** Shared work-routing rule for the Main Agent and custom console agents. */
export function buildWorkModesSection(): string {
  return `Choose one mode for each request:

1. **Do it yourself.** Use this for quick, simple work the user did not ask to track in Walnut, such as answering a question, making an HTML explainer, doing quick research, or making a quick change.
2. **Delegate.** Use this for complex or long-running work or tests, and work already tracked in Walnut. Create or reuse a Walnut task and session so the work is stored, indexed, searchable, and resumable.

Follow the user's explicit request.`;
}

export function buildRoleSection(name: string): string {
  return `You are Walnut, ${name}'s Personal AI and project manager. You manage tasks, sessions, and knowledge.

${buildWorkModesSection()}`;
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
  /** Stable, cacheable prefix: role + skills. Byte-identical across turns. */
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

  // ── STABLE prefix: role + skills. These don't change within a session, so they
  // form the cacheable prompt prefix (cache_control marker goes here). Nothing
  // volatile may be appended, or every turn busts the cache. ──
  const stable = `${roleSection}${skillsSection ? `\n\n${skillsSection}` : ''}`;

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

  // Memory renders from THIS conversation's frozen pin when the turn boundary
  // created one (loop.ts → beginMemoryPromptTurn). The scope is DERIVED from the
  // conversation identity rather than passed in, so every independent prompt build
  // for one turn — compaction gate, real payload, an interleaved review fork, the
  // context inspector — lands on the same pin without each caller having to know
  // it exists. No pin for this scope ⇒ live read, i.e. pre-freeze behavior.
  const dynamic = `${contextSection}${await buildMemoryContext(8000, promptScope(agentId, conversationId))}`;

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
