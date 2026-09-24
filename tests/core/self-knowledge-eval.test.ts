import { describe, expect, it } from 'vitest';
import { buildRoleSection } from '../../src/core/sessions/persona-sections.js';
import { getOp, opInputJsonSchema } from '../../src/ops/index.js';
import { PHASE_ORDER } from '../../src/core/phase.js';
import { renderSelfKnowledgeContract } from '../../src/core/self-knowledge-contract.js';

/** The op registry IS the advertised surface — the session sees these descriptions. */
function tool(name: string) {
  const found = getOp(name);
  if (!found) throw new Error(`missing op: ${name}`);
  return found;
}

describe('Walnut self-knowledge eval contract', () => {
  it('gives the first-tool decision in the stable role section', () => {
    const role = buildRoleSection('Ada');
    const contract = renderSelfKnowledgeContract();
    expect(role).toContain(contract);
    expect(contract).toContain('Do quick, simple work yourself');
    expect(contract).toContain('track and start what they asked for');
    expect(contract).toContain('`task_create` creates AND starts it');
    expect(contract).toContain('`record_only: true` saves a placeholder');
    expect(contract).toContain('Reuse only with an explicit task ID');
  });

  it('starts work by default and requires an explicit placeholder option', () => {
    const create = tool('task_create');
    expect(create.description).toContain('AND START WORK by default');
    expect(create.description).toContain('record_only=true');
    expect(create.description).not.toContain('session_start');

    const start = tool('task_start');
    expect(start.description.length).toBeGreaterThan(40);
  });

  it('names the same task operations in the contract and in the registry', () => {
    // The bootstrap prompt is the only thing a session reads before its first
    // tool call, so an op it names must exist under that exact name.
    const contract = renderSelfKnowledgeContract();
    expect(contract).not.toContain('delegate');
    for (const name of ['task_create', 'task_start', 'task_send', 'task_history']) {
      expect(contract, name).toContain(`\`${name}\``);
      expect(getOp(name), name).toBeDefined();
    }
    expect(getOp('delegate')).toBeUndefined();
    // expect_reply is how a started session reports back — the contract must
    // mention it, since nothing else teaches the reply loop pre-first-call.
    expect(contract).toContain('expect_reply');
    expect(opInputJsonSchema(getOp('task_start')!).properties).toHaveProperty('expect_reply');
    expect(opInputJsonSchema(getOp('task_send')!).properties).toHaveProperty('expect_reply');
  });

  it('offers the whole 5-phase lifecycle, derived from PHASE_ORDER', () => {
    // The human-vs-AI gate is deleted: the op schema is the FULL lifecycle,
    // COMPLETE included, and it comes from PHASE_ORDER so a phase rename can
    // never leave the advertised enum behind.
    const update = getOp('task_update');
    const phaseSchema = opInputJsonSchema(update!);
    const phase = (phaseSchema.properties as Record<string, { enum?: string[] }>).phase;
    expect(phase.enum).toEqual([...PHASE_ORDER]);
    // The two deleted phases must not reappear in the advertised surface.
    expect(phase.enum).not.toContain('HUMAN_VERIFIED');
    expect(phase.enum).not.toContain('POST_WORK_COMPLETED');
    expect(phase.enum).not.toContain('AWAIT_HUMAN_ACTION');
  });

  it('does not teach database or source-code probing for product basics', () => {
    const contract = renderSelfKnowledgeContract();
    expect(contract).toContain('Do not read Walnut databases or source');
    expect(contract).not.toContain('/api/');
    expect(contract).not.toContain('.sqlite');
  });
});
