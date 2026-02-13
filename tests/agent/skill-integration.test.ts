/**
 * Integration test: verifies that skills discovered on disk
 * are injected into the system prompt that reaches the model.
 *
 * Mock: sendMessage (no real LLM calls)
 * Real: skill files on disk, skill-loader, context builder, agent loop
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants());

vi.mock('../../src/agent/model.js', () => ({
  sendMessage: vi.fn(),
  sendMessageStream: vi.fn(),
  resetClient: vi.fn(),
}));

import { WALNUT_HOME, GLOBAL_SKILLS_DIR, CLAUDE_SKILLS_DIR } from '../../src/constants.js';
import { sendMessageStream } from '../../src/agent/model.js';
import { runAgentLoop } from '../../src/agent/loop.js';
import { clearSkillsCache } from '../../src/core/skill-loader.js';
import { cacheTTLTracker } from '../../src/agent/cache.js';

const mockSendMessage = vi.mocked(sendMessageStream);

/** Extract the system prompt string from the sendMessageStream mock call. */
function capturedSystemPrompt(): string {
  const call = mockSendMessage.mock.calls[0];
  if (!call) throw new Error('sendMessageStream was not called');
  const systemArg = call[0].system;
  // system can be string or TextBlockParam[]
  if (typeof systemArg === 'string') return systemArg;
  if (Array.isArray(systemArg)) {
    return systemArg.map((b) => ('text' in b ? b.text : '')).join('');
  }
  return '';
}

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  clearSkillsCache();
  cacheTTLTracker.reset();
  vi.clearAllMocks();
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('Skill → System Prompt integration', () => {
  it('system prompt contains no skills section when no skills exist', async () => {
    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Hi' }],
      stopReason: 'end_turn',
    });

    await runAgentLoop('Hello', []);
    const prompt = capturedSystemPrompt();
    expect(prompt).not.toContain('<available_skills>');
    expect(prompt).not.toContain('## Skills (mandatory)');
  });

  it('system prompt contains skills XML when a skill exists in global dir', async () => {
    // Create a skill on disk
    const skillDir = path.join(GLOBAL_SKILLS_DIR, 'weather');
    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
name: weather
description: Get current weather and forecasts
---
# Weather Skill
Use curl to check weather via wttr.in`,
    );

    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Checking weather...' }],
      stopReason: 'end_turn',
    });

    await runAgentLoop('What is the weather?', []);
    const prompt = capturedSystemPrompt();

    expect(prompt).toContain('## Skills (mandatory)');
    expect(prompt).toContain('<available_skills>');
    expect(prompt).toContain('<name>weather</name>');
    expect(prompt).toContain('<description>Get current weather and forecasts</description>');
    expect(prompt).toContain('<location>');
    expect(prompt).toContain('SKILL.md</location>');
  });

  it('system prompt contains multiple skills from different dirs', async () => {
    // Global skill
    const globalDir = path.join(GLOBAL_SKILLS_DIR, 'deploy');
    await fsp.mkdir(globalDir, { recursive: true });
    await fsp.writeFile(
      path.join(globalDir, 'SKILL.md'),
      `---
name: deploy
description: Deploy services to production
---
# Deploy Skill`,
    );

    // Claude skill
    const claudeDir = path.join(CLAUDE_SKILLS_DIR, 'github');
    await fsp.mkdir(claudeDir, { recursive: true });
    await fsp.writeFile(
      path.join(claudeDir, 'SKILL.md'),
      `---
name: github
description: Interact with GitHub using the gh CLI
---
# GitHub Skill`,
    );

    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Done' }],
      stopReason: 'end_turn',
    });

    await runAgentLoop('Help me deploy', []);
    const prompt = capturedSystemPrompt();

    expect(prompt).toContain('<name>deploy</name>');
    expect(prompt).toContain('<name>github</name>');
  });

  it('ineligible skills are excluded from system prompt', async () => {
    // Create an ineligible skill (requires missing binary)
    const skillDir = path.join(GLOBAL_SKILLS_DIR, 'broken');
    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
name: broken
description: Needs a binary that does not exist
metadata:
  openclaw:
    requires:
      bins:
        - __does_not_exist_xyz__
---
# Broken`,
    );

    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Ok' }],
      stopReason: 'end_turn',
    });

    await runAgentLoop('Hello', []);
    const prompt = capturedSystemPrompt();

    expect(prompt).not.toContain('broken');
    expect(prompt).not.toContain('<available_skills>');
  });

  it('higher priority skill wins when same name exists in multiple dirs', async () => {
    // Global (higher priority)
    const globalDir = path.join(GLOBAL_SKILLS_DIR, 'dupe');
    await fsp.mkdir(globalDir, { recursive: true });
    await fsp.writeFile(
      path.join(globalDir, 'SKILL.md'),
      `---
name: dupe
description: Global version wins
---
# Global`,
    );

    // Claude (lower priority)
    const claudeDir = path.join(CLAUDE_SKILLS_DIR, 'dupe');
    await fsp.mkdir(claudeDir, { recursive: true });
    await fsp.writeFile(
      path.join(claudeDir, 'SKILL.md'),
      `---
name: dupe
description: Claude version should lose
---
# Claude`,
    );

    mockSendMessage.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Ok' }],
      stopReason: 'end_turn',
    });

    await runAgentLoop('test', []);
    const prompt = capturedSystemPrompt();

    expect(prompt).toContain('Global version wins');
    expect(prompt).not.toContain('Claude version should lose');
  });
});
