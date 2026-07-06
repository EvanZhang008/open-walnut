import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants());

// Mock chat-history with a hoisted mock function
vi.mock('../../src/core/chat-history.js', () => ({
  getCompactionSummary: vi.fn().mockResolvedValue(null),
  getCompactionEntryCount: vi.fn().mockReturnValue(0),
  loadChatHistory: vi.fn().mockResolvedValue({ messages: [], meta: {} }),
}));

import {
  WALNUT_HOME,
  MEMORY_INDEX_FILE,
  WORKING_MEMORY_FILE,
  DAILY_DIR,
} from '../../src/constants.js';
import { buildMemoryContext, buildSystemPrompt, buildSystemPromptSplit } from '../../src/agent/context.js';
import { formatDateKey } from '../../src/core/daily-log.js';
import { WORKING_MEMORY_TEMPLATE } from '../../src/core/working-memory.js';
import type { AgentDefinition } from '../../src/core/types.js';
import { loadContextSources } from '../../src/agent/context-sources.js';
import { getCompactionSummary } from '../../src/core/chat-history.js';

/**
 * Suite 7 (Test Plan Suite 8): Context Injection (Unit)
 */

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  vi.mocked(getCompactionSummary).mockReset();
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('buildMemoryContext', () => {
  it('8.1: uses 8K budget and contains expected sections', async () => {
    // Create minimal data
    fs.mkdirSync(DAILY_DIR, { recursive: true });
    const dateKey = formatDateKey();
    fs.writeFileSync(
      path.join(DAILY_DIR, `${dateKey}.md`),
      `# Daily Log: ${dateKey}\n\n## 10:00 -- agent\nWorked on tests.\n`,
      'utf-8',
    );

    const result = await buildMemoryContext();
    expect(typeof result).toBe('string');
    expect(result).toContain('## Task Categories & Projects');
    expect(result).toContain('## Your long-term memory');
    expect(result).toContain('## Recent activity');
    expect(result).toContain('memory_notes_search');
  });

  it('8.2: never injects the retired memory index (even when the file exists)', async () => {
    // memory/index.md is retired (2026-07 unification): directory awareness
    // comes from the skills index. A leftover file must NOT be injected.
    fs.mkdirSync(path.dirname(MEMORY_INDEX_FILE), { recursive: true });
    fs.writeFileSync(
      MEMORY_INDEX_FILE,
      '# Memory Index\n## Topics\n- [Walnut](topics/walnut.md)',
      'utf-8',
    );

    const result = await buildMemoryContext();
    expect(result).not.toContain('## Memory index');
  });

  it('8.3: omits memory index when absent', async () => {
    const result = await buildMemoryContext();
    expect(result).not.toContain('## Memory index');
  });
});

describe('buildSystemPrompt — working memory injection', () => {
  it('8.4: working memory injected after compaction', async () => {
    // Write real content to WORKING_MEMORY_FILE
    fs.mkdirSync(path.dirname(WORKING_MEMORY_FILE), { recursive: true });
    fs.writeFileSync(WORKING_MEMORY_FILE, '# Active Focus\nWorking on Memory v2 E2E tests\n', 'utf-8');

    // Simulate compaction has occurred
    vi.mocked(getCompactionSummary).mockResolvedValue('Previous compaction summary');

    const prompt = await buildSystemPrompt();

    expect(prompt).toContain('## Earlier conversation context (working memory)');
    expect(prompt).toContain('Working on Memory v2 E2E tests');
  });

  it('8.5: compaction summary used when working memory is empty', async () => {
    // Write only template
    fs.mkdirSync(path.dirname(WORKING_MEMORY_FILE), { recursive: true });
    fs.writeFileSync(WORKING_MEMORY_FILE, WORKING_MEMORY_TEMPLATE, 'utf-8');

    vi.mocked(getCompactionSummary).mockResolvedValue('Previous context summary...');

    const prompt = await buildSystemPrompt();

    expect(prompt).toContain('## Earlier conversation context');
    expect(prompt).toContain('Previous context summary...');
    expect(prompt).not.toContain('(working memory)');
  });

  it('8.6: no context section on fresh conversation (no compaction)', async () => {
    vi.mocked(getCompactionSummary).mockResolvedValue(null);

    const prompt = await buildSystemPrompt();

    expect(prompt).not.toContain('## Earlier conversation context');
  });

  it('8.8: injected summary carries the "background reference, do not resume" preface', async () => {
    // The preface is the semantic guard against replaying stale "In Progress"/"Next Steps"
    // items as fresh tasks (the 13-orphan batch-bug family). It must appear with the summary.
    fs.mkdirSync(path.dirname(WORKING_MEMORY_FILE), { recursive: true });
    fs.writeFileSync(WORKING_MEMORY_FILE, WORKING_MEMORY_TEMPLATE, 'utf-8'); // empty → use summary branch
    vi.mocked(getCompactionSummary).mockResolvedValue('## Next Steps\n1. Re-query CIS accounts');

    const prompt = await buildSystemPrompt();

    expect(prompt).toContain('## Earlier conversation context');
    expect(prompt).toContain('Background reference only');
    expect(prompt).toContain('Do NOT resume');
    expect(prompt).toContain('latest message is the only source of truth');
    // Preface must come BEFORE the summary body so the agent reads the framing first.
    expect(prompt.indexOf('Background reference only')).toBeLessThan(prompt.indexOf('Re-query CIS accounts'));
  });

  it('8.9: preface is also applied to the working-memory branch', async () => {
    fs.mkdirSync(path.dirname(WORKING_MEMORY_FILE), { recursive: true });
    fs.writeFileSync(WORKING_MEMORY_FILE, '# Active Focus\nMid-refactor of the compaction gate\n', 'utf-8');
    vi.mocked(getCompactionSummary).mockResolvedValue('Previous compaction summary');

    const prompt = await buildSystemPrompt();

    expect(prompt).toContain('## Earlier conversation context (working memory)');
    expect(prompt).toContain('Background reference only');
    expect(prompt).toContain('Mid-refactor of the compaction gate');
    expect(prompt.indexOf('Background reference only')).toBeLessThan(prompt.indexOf('Mid-refactor of the compaction gate'));
  });
});

describe('buildSystemPromptSplit — stable / dynamic cache split (Thing 2)', () => {
  it('keeps volatile memory context OUT of the stable (cacheable) prefix', async () => {
    fs.mkdirSync(DAILY_DIR, { recursive: true });
    const dateKey = formatDateKey();
    fs.writeFileSync(
      path.join(DAILY_DIR, `${dateKey}.md`),
      `# Daily Log: ${dateKey}\n\n## 10:00 -- agent\nWorked on cache split.\n`,
      'utf-8',
    );
    vi.mocked(getCompactionSummary).mockResolvedValue(null);

    const { stable, dynamic } = await buildSystemPromptSplit();

    // The memory context (task inventory, daily logs) is volatile and must live in
    // `dynamic`, never in the cached `stable` prefix. Assert on the section headers,
    // which are unique to buildMemoryContext (tool *names* like memory_notes_search
    // also appear in the stable role prompt, so they're not a reliable discriminator).
    expect(stable).not.toContain('## Task Categories & Projects');
    expect(stable).not.toContain('## Recent activity');
    expect(dynamic).toContain('## Task Categories & Projects');
    expect(dynamic).toContain('## Recent activity');
  });

  it('routes the per-conversation "Earlier conversation context" into dynamic, not stable', async () => {
    fs.mkdirSync(path.dirname(WORKING_MEMORY_FILE), { recursive: true });
    fs.writeFileSync(WORKING_MEMORY_FILE, WORKING_MEMORY_TEMPLATE, 'utf-8'); // empty → summary branch
    vi.mocked(getCompactionSummary).mockResolvedValue('Prior summary text');

    const { stable, dynamic } = await buildSystemPromptSplit();

    expect(stable).not.toContain('## Earlier conversation context');
    expect(dynamic).toContain('## Earlier conversation context');
    expect(dynamic).toContain('Prior summary text');
  });

  it('CORE INVARIANT: stable prefix is byte-identical even as the volatile memory context changes', async () => {
    vi.mocked(getCompactionSummary).mockResolvedValue(null);

    // Turn 1: one daily log.
    fs.mkdirSync(DAILY_DIR, { recursive: true });
    const dateKey = formatDateKey();
    const logPath = path.join(DAILY_DIR, `${dateKey}.md`);
    fs.writeFileSync(logPath, `# Daily Log: ${dateKey}\n\n## 10:00 -- agent\nfirst activity\n`, 'utf-8');
    const turn1 = await buildSystemPromptSplit();

    // Turn 2: the daily log grew (a real every-turn change). The dynamic part must
    // differ, but the cached stable prefix must NOT — otherwise the cache misses.
    fs.appendFileSync(logPath, '## 11:00 -- agent\nsecond activity, totally different\n', 'utf-8');
    const turn2 = await buildSystemPromptSplit();

    expect(turn2.stable).toBe(turn1.stable);     // ← the cache-hit guarantee
    expect(turn2.dynamic).not.toBe(turn1.dynamic); // sanity: the volatile part did change
  });

  it('backward-compatible buildSystemPrompt = stable + dynamic concatenated', async () => {
    vi.mocked(getCompactionSummary).mockResolvedValue(null);
    const { stable, dynamic } = await buildSystemPromptSplit();
    const full = await buildSystemPrompt();
    expect(full).toBe(`${stable}\n\n${dynamic}`);
  });
});

describe('working_memory context source for subagents', () => {
  it('8.7: loads working memory content', async () => {
    fs.mkdirSync(path.dirname(WORKING_MEMORY_FILE), { recursive: true });
    fs.writeFileSync(
      WORKING_MEMORY_FILE,
      '# Active Focus\nWorking on Memory v2 tests\n# User Requests\nDesign test plan\n',
      'utf-8',
    );

    const agentDef: AgentDefinition = {
      id: 'test-agent',
      name: 'Test Agent',
      model: 'test',
      system_prompt: 'You are a test agent.',
      context_sources: [
        { id: 'working_memory', enabled: true },
      ],
    };

    const result = await loadContextSources(agentDef, {});
    expect(result).toContain('<working_memory>');
    expect(result).toContain('Working on Memory v2 tests');
  });

  it('8.8: returns placeholder when empty', async () => {
    fs.mkdirSync(path.dirname(WORKING_MEMORY_FILE), { recursive: true });
    fs.writeFileSync(WORKING_MEMORY_FILE, WORKING_MEMORY_TEMPLATE, 'utf-8');

    const agentDef: AgentDefinition = {
      id: 'test-agent',
      name: 'Test Agent',
      model: 'test',
      system_prompt: 'You are a test agent.',
      context_sources: [
        { id: 'working_memory', enabled: true },
      ],
    };

    const result = await loadContextSources(agentDef, {});
    expect(result).toContain('(no working memory yet)');
  });
});
