import { describe, expect, it } from 'vitest';
import { buildRoleSection } from '../../src/agent/context.js';
import { getToolSchemas } from '../../src/agent/tools.js';
import { getOp, opInputJsonSchema } from '../../src/ops/index.js';
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
    const delegate = tool('delegate');
    const create = tool('task_create');
    expect(delegate.description).toContain('Use task_create instead when the user only wants to record work');
    expect(create.description).toContain('without starting any work or session');
    expect(create.description).toContain('use delegate instead');
  });

  it('keeps the registry as the single schema source for delegate', () => {
    const delegate = tool('delegate');
    const op = getOp('delegate');
    expect(op).toBeDefined();
    expect(delegate.description).toBe(op?.description);
    expect(delegate.input_schema).toEqual(opInputJsonSchema(op!));
  });

  it('allows agent handoff but exposes no human completion tool', () => {
    const update = getOp('task_update');
    const phaseSchema = opInputJsonSchema(update!);
    const phase = (phaseSchema.properties as Record<string, { enum?: string[] }>).phase;
    expect(phase.enum).toContain('AGENT_COMPLETE');
    expect(phase.enum).toContain('AWAIT_HUMAN_ACTION');
    expect(phase.enum).not.toContain('HUMAN_VERIFIED');
    expect(phase.enum).not.toContain('POST_WORK_COMPLETED');
    expect(phase.enum).not.toContain('COMPLETE');
    expect(getToolSchemas().some((entry) => entry.name === 'task_complete')).toBe(false);
  });

  it('does not teach database or source-code probing for product basics', () => {
    const contract = renderSelfKnowledgeContract();
    expect(contract).toContain('Do not inspect Walnut databases or source code');
    expect(contract).not.toContain('/api/');
    expect(contract).not.toContain('.sqlite');
  });
});
