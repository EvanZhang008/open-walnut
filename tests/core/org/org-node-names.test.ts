/**
 * Every org node is reached by its names (src/core/org/org-tree.ts orgNodeNames / orgNodeNamed),
 * through org_send (/org/contact) and task_send (/messages) alike.
 *
 * 2026-11-11: a VP answering Main's note sent org_send to "Main" and was told unknown_contact,
 * because only a VP's user-given name was looked up; "Walnut VP" (an unnamed VP's own display
 * name) and "CEO" failed the same way. The guard below enumerates the org roles from the source,
 * so a new kind of org node must say how it is named (or why it is not) before it ships.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-org-node-names'));
import {
  isOrgNode, namesMain, orgDisplayTitle, orgNodeNamed, orgNodeNames, type OrgTaskLike,
} from '../../../src/core/org/org-tree.js';
import { cleanVpName } from '../../../src/core/org/org-node-edit.js';

/** Org roles whose nodes take messages by name: each must resolve by its display and role name. */
const NAMED_ROLES = new Set(['main', 'lead']);
/** Org roles that are reached by task id only, with why. */
const UNNAMED_ROLES: Record<string, string> = {
  router: 'a mail router routes mail into tasks; nobody org_sends it work, so it is reached by its task id',
};

function orgRolesInSource(): string[] {
  const src = fs.readFileSync(path.resolve(__dirname, '../../../src/core/types.ts'), 'utf8');
  const m = src.match(/export type OrgRole\s*=\s*([^;]+);/);
  if (!m) throw new Error('OrgRole not found in src/core/types.ts');
  return [...m[1]!.matchAll(/'([a-z_-]+)'/g)].map((x) => x[1]!);
}

const t = (over: Partial<OrgTaskLike> & { id: string }): OrgTaskLike =>
  ({ title: over.id, phase: 'IN_PROGRESS', created_at: '2026-11-01T00:00:00Z', ...over }) as OrgTaskLike;

/** One org with every kind of node the store holds today. */
const ORG: OrgTaskLike[] = [
  t({ id: 'main-1', title: 'CEO', org_role: 'main', project: 'Ask Walnut' }),
  t({ id: 'vp-named', title: 'Garden VP', org_role: 'lead', project: 'Garden', org_name: 'Green Thumb' }),
  t({ id: 'vp-plain', title: 'Marina VP', org_role: 'lead', project: 'Marina' }),
  t({ id: 'vp-old-title', title: 'Site lead', org_role: 'lead', project: 'Site' }),
  t({ id: 'vp-two', title: 'Walnut VP', org_role: 'lead', project: 'Walnut', org_leads: ['Docs'] } as Partial<OrgTaskLike> & { id: string }),
  t({ id: 'vp-closed', title: 'Old VP', org_role: 'lead', project: 'Old', phase: 'COMPLETE' }),
  t({ id: 'router-1', title: 'Mail router', org_role: 'router', org_name: 'Mail router' }),
  t({ id: 'work-1', title: 'Main dashboard polish', project: 'Walnut' }),
  t({ id: 'work-2', title: 'CEO letter draft', project: 'Walnut' }),
];

/** The role name a node goes by in prompts and code: "Main", or its project's "<project> VP". */
function roleNames(node: OrgTaskLike): string[] {
  if (node.org_role === 'main') return ['Main'];
  const project = (node.project ?? '').trim();
  return [`${project} VP`, `${project} lead`];
}

describe('every org node resolves by its names', () => {
  it('each org role is named, or says why it is not', () => {
    for (const role of orgRolesInSource()) {
      expect(NAMED_ROLES.has(role) || role in UNNAMED_ROLES, `org role "${role}" has no naming rule: add it to orgNodeNames or UNNAMED_ROLES`).toBe(true);
    }
  });

  it('Main and every open VP: display name, role name, the user-given name and every listed name', () => {
    const nodes = ORG.filter((n) => isOrgNode(n) && NAMED_ROLES.has(n.org_role!) && n.phase !== 'COMPLETE');
    expect(nodes.map((n) => n.id)).toEqual(['main-1', 'vp-named', 'vp-plain', 'vp-old-title', 'vp-two']);
    for (const node of nodes) {
      // Written out from the node's fields, never read back from orgNodeNames.
      const names = [orgDisplayTitle(node), node.title, ...roleNames(node)];
      if (node.org_name) names.push(node.org_name, `${node.org_name} VP`, `${node.org_name} lead`);
      for (const name of names) {
        for (const written of [name, name.toUpperCase(), `  ${name.toLowerCase()}  `, `the ${name}`]) {
          expect(orgNodeNamed(ORG, written)?.id, `"${written}" should name ${node.id}`).toBe(node.id);
        }
      }
    }
  });

  it('Main answers to "Main", "Main agent" and "CEO", and to a title the user gave it', () => {
    for (const name of ['Main', 'main agent', 'CEO', 'the CEO']) expect(orgNodeNamed(ORG, name)?.id).toBe('main-1');
    const renamed = ORG.map((n) => (n.id === 'main-1' ? { ...n, title: 'My coordinator' } : n));
    for (const name of ['Main', 'CEO', 'My coordinator']) expect(orgNodeNamed(renamed, name)?.id).toBe('main-1');
  });

  it('lists exactly the names written out for each node', () => {
    const of = (id: string) => orgNodeNames(ORG.find((n) => n.id === id)!).sort();
    expect(of('main-1')).toEqual(['ceo', 'main', 'main agent']);
    expect(of('vp-named')).toEqual(['garden lead', 'garden vp', 'green thumb', 'green thumb lead', 'green thumb vp']);
    expect(of('vp-old-title')).toEqual(['site lead', 'site vp']);
    expect(of('router-1')).toEqual([]);
    expect(of('work-1')).toEqual([]);
  });

  it('names nothing for work, a closed VP, a router, a bare project or a near miss', () => {
    for (const name of ['Main dashboard', 'CEO letter draft', 'Old VP', 'Mail router', 'Marina', 'Garden', 'Mainx', 'VP', '', '   ']) {
      expect(orgNodeNamed(ORG, name), `"${name}"`).toBeUndefined();
    }
  });

  it('a name two open VPs share goes to the one the user named, else to neither', () => {
    const shared = [
      ...ORG,
      t({ id: 'vp-marina-named', title: 'Boats VP', org_role: 'lead', project: 'Boats', org_name: 'Marina' }),
    ];
    expect(orgNodeNamed(shared, 'Marina VP')?.id).toBe('vp-marina-named');
    const twins = [
      t({ id: 'a', title: 'Twin VP', org_role: 'lead', project: 'Twin' }),
      t({ id: 'b', title: 'Twin VP', org_role: 'lead', project: 'twin' }),
    ];
    expect(orgNodeNamed(twins, 'Twin VP')).toBeUndefined();
  });

  it('no VP may take a name Main goes by', () => {
    for (const name of ['Main', 'CEO', 'ceo VP', 'Main agent']) {
      expect(namesMain(name.replace(/\s+VP$/i, ''))).toBe(true);
      expect(() => cleanVpName(name)).toThrow(/CEO goes by/);
    }
    expect(cleanVpName('Green Thumb VP')).toBe('Green Thumb');
  });
});
