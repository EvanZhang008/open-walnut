import { describe, expect, it } from 'vitest';
import { buildRoleSection } from '../../src/agent/context.js';
import { getToolSchemas } from '../../src/agent/tools.js';
import { getOp, opInputJsonSchema } from '../../src/ops/index.js';
import { PHASE_ORDER } from '../../src/core/phase.js';
import { renderSelfKnowledgeContract } from '../../src/core/self-knowledge-contract.js';

function tool(name: string) {
  const found = getToolSchemas().find((entry) => entry.name === name);
  if (!found) throw new Error(`missing agent tool: ${name}`);
  return found;
}

describe('Main Agent self-knowledge eval contract', () => {
  it('gives the first-tool decision in the stable role section', () => {
    const role = buildRoleSection('Ada');
    const contract = renderSelfKnowledgeContract();
    expect(role).toContain(contract);
    expect(contract).toContain('Do quick, simple work yourself');
    expect(contract).toContain('Delegate complex, long-running, or already-tracked work');
    expect(contract).toContain('`task_create` records work only');
    expect(contract).toContain('Reuse only with an explicit task ID');
  });

  it('makes tracking-only and execution tools mutually explicit', () => {
    // `delegate` folded the two into one call and is gone. The pairing still has
    // to be explicit, or the Main Agent records work the user asked it to do:
    // task_create says it starts nothing AND names what does.
    const create = tool('task_create');
    expect(create.description).toContain('without starting any work or session');
    expect(create.description).toContain('follow with session_start');
    expect(create.description).not.toContain('delegate');

    const start = tool('session_start');
    expect(start.description.length).toBeGreaterThan(40);
  });

  it('names the same two verbs in the contract and in the registry', () => {
    // The bootstrap prompt is the only thing the Main Agent reads before its
    // first tool call, so an op it names must exist under that exact name.
    const contract = renderSelfKnowledgeContract();
    expect(contract).not.toContain('delegate');
    for (const name of ['task_create', 'session_start', 'session_send']) {
      expect(contract, name).toContain(`\`${name}\``);
      expect(getOp(name), name).toBeDefined();
    }
    expect(getOp('delegate')).toBeUndefined();
    // expect_reply is how a started session reports back — the contract must
    // mention it, since nothing else teaches the reply loop pre-first-call.
    expect(contract).toContain('expect_reply');
    expect(opInputJsonSchema(getOp('session_start')!).properties).toHaveProperty('expect_reply');
    expect(opInputJsonSchema(getOp('session_send')!).properties).toHaveProperty('expect_reply');
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
    expect(contract).toContain('Do not inspect Walnut databases or source code');
    expect(contract).not.toContain('/api/');
    expect(contract).not.toContain('.sqlite');
  });
});
