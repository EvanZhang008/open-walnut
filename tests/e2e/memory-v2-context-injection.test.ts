/**
 * Category 4: Memory Context Injection E2E
 *
 * Tests system prompt memory index injection, memory context building,
 * compaction working memory integration, and context source loading.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import {
  seedMemoryIndex,
  seedGlobalMemory,
  seedDailyLog,
  seedProjectMemory,
  seedWorkingMemory,
  daysAgoStr,
} from '../helpers/memory-v2-seeders.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  WALNUT_HOME,
  MEMORY_DIR,
  MEMORY_INDEX_FILE,
  WORKING_MEMORY_FILE,
  CHAT_HISTORY_FILE,
  conversationFile,
  workingMemoryFile,
} from '../../src/constants.js';
import { buildMemoryContext, buildSystemPrompt } from '../../src/agent/context.js';
import { WORKING_MEMORY_TEMPLATE } from '../../src/core/working-memory.js';
import { createConversation } from '../../src/core/conversations.js';
import { loadContextSources } from '../../src/agent/context-sources.js';
import type { AgentDefinition, ContextSourceId } from '../../src/core/types.js';

/** Seed a conversation's chat store with a compaction summary. */
function seedConversationSummary(convId: string, summary: string): void {
  fs.mkdirSync(path.dirname(conversationFile('general', convId)), { recursive: true });
  fs.writeFileSync(
    conversationFile('general', convId),
    JSON.stringify({ version: 2, lastUpdated: new Date().toISOString(), compactionCount: 1, compactionSummary: summary, entries: [] }),
    'utf-8',
  );
}

/** Seed a conversation's per-conversation working memory. */
function seedConvWorkingMemory(convId: string, content: string): void {
  const f = workingMemoryFile('general', convId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content, 'utf-8');
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  await fsp.mkdir(MEMORY_DIR, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ── 4.1 System Prompt Includes Memory Index ──

describe('System Prompt Memory Index (retired)', () => {
  it('4.1: buildMemoryContext never injects the retired memory index', async () => {
    // memory/index.md is retired (2026-07 unification): directory awareness
    // comes from the skills index. Even a leftover file must NOT be injected.
    const indexContent = `# Memory Index

## Topics
- [Database Architecture](topics/database-architecture.md) -- PostgreSQL + pgBouncer setup
`;
    seedMemoryIndex(WALNUT_HOME, indexContent);

    const context = await buildMemoryContext(8000);

    expect(context).not.toContain('## Memory index');
    expect(context).not.toContain('Database Architecture');
  });
});

// ── 4.2 System Prompt Includes Memory Context ──

describe('Memory Context', () => {
  it('4.2: buildMemoryContext includes global memory and projects', async () => {
    seedGlobalMemory(WALNUT_HOME, 'Global preference: dark mode, concise responses.');
    seedDailyLog(WALNUT_HOME, daysAgoStr(0), 'Today I worked on memory v2 context injection tests.');
    seedProjectMemory(WALNUT_HOME, 'work', 'walnut', 'Walnut is a personal AI butler project.');

    const context = await buildMemoryContext(8000);

    expect(context).toContain('## Your long-term memory');
    expect(context).toContain('dark mode, concise responses');
    expect(context).toContain('## Your projects');
    expect(context).toContain('walnut');
    expect(context).toContain('## Recent activity');
    expect(context).toContain('memory v2 context injection tests');

    // Tool mention at the end
    expect(context).toContain('memory_notes_search');
    expect(context).toContain('file_read');
  });
});

// ── 4.5 Post-Compaction System Prompt Includes Working Memory ──

describe('Post-Compaction System Prompt', () => {
  it('4.5: system prompt with compaction summary uses working memory when available', async () => {
    // Conversation-scoped: the system prompt for a conversation reads THAT
    // conversation's compaction summary + working memory (not the legacy ghost file).
    const conv = await createConversation('general', 'WM test');
    seedConversationSummary(conv.id, 'This is a previous compaction summary from LLM.');
    const wmContent = '# Active Focus\nBuilding memory v2 E2E tests.\n# User Requests\nUser asked for test coverage.\n# Decisions & Rationale\n_empty_\n# Struggles & Breakthroughs\n_empty_\n# Session Status\n_empty_\n# Open Threads\n_empty_\n# Learnings\n_empty_';
    seedConvWorkingMemory(conv.id, wmContent);

    // Seed minimal config
    const configContent = `user:\n  name: TestUser\n`;
    fs.writeFileSync(WALNUT_HOME + '/config.yaml', configContent, 'utf-8');

    const prompt = await buildSystemPrompt('general', conv.id);

    // Should prefer working memory over compaction summary
    expect(prompt).toContain('## Earlier conversation context (working memory)');
    expect(prompt).toContain('Building memory v2 E2E tests');
  });

  it('4.5b: system prompt uses compaction summary when working memory is empty', async () => {
    const conv = await createConversation('general', 'WM empty test');
    seedConversationSummary(conv.id, 'This is the LLM compaction summary.');
    // Empty working memory (template only) → should fall back to the summary
    seedConvWorkingMemory(conv.id, WORKING_MEMORY_TEMPLATE);

    // Seed minimal config
    const configContent = `user:\n  name: TestUser\n`;
    fs.writeFileSync(WALNUT_HOME + '/config.yaml', configContent, 'utf-8');

    const prompt = await buildSystemPrompt('general', conv.id);

    // Should fall back to compaction summary
    expect(prompt).toContain('## Earlier conversation context');
    expect(prompt).toContain('LLM compaction summary');
    // Should NOT show working memory heading
    expect(prompt).not.toContain('## Earlier conversation context (working memory)');
  });
});

// ── 4.6 Context Source: working_memory in Subagent ──

describe('Context Sources', () => {
  it('4.6: working_memory context source loads correctly', async () => {
    // A subagent's working_memory source reads the General agent's MAIN
    // conversation scratchpad. Seed that conversation's working memory.
    const { getMainConversationId } = await import('../../src/core/conversations.js');
    const mainConvId = await getMainConversationId('general');
    const wmContent = '# Active Focus\nTesting context sources for subagents.\n# User Requests\nRun memory E2E tests.\n# Decisions & Rationale\n_empty_\n# Struggles & Breakthroughs\n_empty_\n# Session Status\n_empty_\n# Open Threads\n_empty_\n# Learnings\n_empty_';
    seedConvWorkingMemory(mainConvId, wmContent);

    // Create a mock agent definition with working_memory context source
    const agentDef: AgentDefinition = {
      id: 'test-agent',
      name: 'Test Agent',
      system_prompt: 'You are a test agent.',
      model: 'test',
      context_sources: [
        { id: 'working_memory' as ContextSourceId, enabled: true },
      ],
    };

    const result = await loadContextSources(agentDef, {});

    expect(result).toContain('<working_memory>');
    expect(result).toContain('</working_memory>');
    expect(result).toContain('Testing context sources for subagents');
  });

  it('4.6b: empty working memory returns placeholder text', async () => {
    seedWorkingMemory(WALNUT_HOME, WORKING_MEMORY_TEMPLATE);

    const agentDef: AgentDefinition = {
      id: 'test-agent',
      name: 'Test Agent',
      system_prompt: 'You are a test agent.',
      model: 'test',
      context_sources: [
        { id: 'working_memory' as ContextSourceId, enabled: true },
      ],
    };

    const result = await loadContextSources(agentDef, {});

    expect(result).toContain('<working_memory>');
    expect(result).toContain('(no working memory yet)');
  });
});
