/**
 * Category 4: Context source loading E2E
 *
 * A subagent's declared context sources are rendered from real files on disk,
 * so this exercises `loadContextSources` against a seeded home rather than a
 * stub.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { seedWorkingMemory } from '../helpers/memory-v2-seeders.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, MEMORY_DIR, workingMemoryFile } from '../../src/constants.js';
import { WORKING_MEMORY_TEMPLATE } from '../../src/core/working-memory.js';
import { loadContextSources } from '../../src/core/context-sources.js';
import type { AgentDefinition, ContextSourceId } from '../../src/core/types.js';

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
