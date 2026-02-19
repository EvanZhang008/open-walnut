/**
 * E2E tests for the skill system with a real LLM.
 *
 * These tests make real Bedrock API calls. They are skipped when
 * credentials are not available (no AWS_BEARER_TOKEN_BEDROCK and no
 * standard AWS credentials configured).
 *
 * Run explicitly: npm test -- tests/e2e/skill-e2e.test.ts
 *
 * Note: the walnut agent loop does NOT include a file-read tool, so
 * the LLM cannot read SKILL.md bodies at runtime. It can only see
 * the skill names and descriptions from the <available_skills> XML
 * in the system prompt. All testable behavior must come from the
 * description field.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { hasAwsCredentials } from '../helpers/live.js';

const HAS_CREDS = hasAwsCredentials();

// ── mock constants to a stable temp dir ─────────────────────────────
// We mock constants (so skill dirs resolve to our temp) but keep
// sendMessage real (actual LLM calls).

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, GLOBAL_SKILLS_DIR } from '../../src/constants.js';
import { clearSkillsCache } from '../../src/core/skill-loader.js';
import { resetClient } from '../../src/agent/model.js';
import { runAgentLoop } from '../../src/agent/loop.js';
import { cacheTTLTracker } from '../../src/agent/cache.js';

// ── setup / teardown ────────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  if (!HAS_CREDS) {
    console.log('Skipping skill E2E tests: no AWS credentials available');
  }
});

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  clearSkillsCache();
  resetClient();
  cacheTTLTracker.reset();
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ── helpers ─────────────────────────────────────────────────────────

async function createSkill(name: string, description: string): Promise<void> {
  const dir = path.join(GLOBAL_SKILLS_DIR, name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
  );
}

// ── tests ───────────────────────────────────────────────────────────

describe.skipIf(!HAS_CREDS)('Skill E2E (real LLM)', () => {
  /**
   * Core test: the LLM sees a skill whose description contains
   * a code-word trigger and a specific response marker.
   */
  it('agent follows a skill that instructs a specific response', async () => {
    await createSkill(
      'echo-marker',
      'When the user says "echo test", you MUST respond with exactly the string SKILL_ECHO_OK_7X3Q and nothing else.',
    );

    const result = await runAgentLoop('echo test', [], { onTextDelta: () => {} });
    expect(result.response).toContain('SKILL_ECHO_OK_7X3Q');
  }, 30000);

  /**
   * Multi-skill: two skills with non-overlapping code-word triggers.
   * The LLM should pick the matching one.
   */
  it('agent picks the correct skill from multiple options', async () => {
    await createSkill(
      'protocol-alpha',
      'When the user says "protocol alpha", respond with exactly ALPHA_CONFIRMED_4R7T and nothing else.',
    );
    await createSkill(
      'protocol-beta',
      'When the user says "protocol beta", respond with exactly BETA_CONFIRMED_6W2K and nothing else.',
    );

    const result = await runAgentLoop('protocol alpha', [], { onTextDelta: () => {} });

    expect(result.response).toContain('ALPHA_CONFIRMED_4R7T');
    expect(result.response).not.toContain('BETA_CONFIRMED_6W2K');
  }, 30000);

  /**
   * Negative test: when no skill matches the query, the LLM should
   * answer normally without any skill markers.
   */
  it('agent ignores skills when none match the query', async () => {
    await createSkill(
      'scuba-diving',
      'When the user asks about scuba diving or diving equipment, start your response with SCUBA_MARKER_5Z1W.',
    );

    const result = await runAgentLoop('What is the capital of France?', [], { onTextDelta: () => {} });

    expect(result.response).not.toContain('SCUBA_MARKER_5Z1W');
    expect(result.response.toLowerCase()).toContain('paris');
  }, 30000);
});
