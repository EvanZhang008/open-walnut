import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyGeneratedBlock, generateOpsCatalog } from '../../scripts/generate-ops-docs.mjs';
import { listOps } from '../../src/ops/index.js';

const skillPath = path.resolve('src/data/skills/walnut/SKILL.md');
const target = { path: skillPath, required: true };

describe('generated operations docs', () => {
  it('keeps the shipped Walnut skill in sync with the registry', () => {
    const current = fs.readFileSync(skillPath, 'utf-8');
    expect(applyGeneratedBlock(current, target)).toBe(current);
  });

  it('renders every op and preserves schema details', () => {
    const catalog = generateOpsCatalog();
    for (const op of listOps()) expect(catalog).toContain(`\`${op.name}\``);
    expect(catalog).toContain('types? (string)');
    expect(catalog).toContain('task,memory,session');
    expect(catalog).toContain('array<string>');
  });
});
