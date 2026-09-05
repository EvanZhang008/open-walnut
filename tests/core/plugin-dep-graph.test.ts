/**
 * Unit tests for the plugin dependency graph (src/core/plugins/dep-graph.ts).
 *
 * The load order this graph produces is user-visible (a plugin that activates
 * before its dependency sees a half-built host), so the properties pinned here are
 * the contract: no edges means "keep discovery order", edges win over order, and a
 * cycle is reported rather than guessed at.
 */
import { describe, it, expect } from 'vitest';
import {
  buildDepGraph,
  topoSortStable,
  dependentsOf,
  dependentsTeardownOrder,
  type DepGraphNode,
} from '../../src/core/plugins/dep-graph.js';

/** Nodes in the given order, indexed by position (what the loader passes). */
function nodes(...specs: Array<[string, string[]]>): DepGraphNode[] {
  return specs.map(([id, deps], index) => ({ id, index, deps }));
}

describe('topoSortStable', () => {
  it('preserves input order when there are no edges', () => {
    const graph = buildDepGraph(nodes(['local', []], ['zeta', []], ['alpha', []], ['mid', []]));

    const { order, residue } = topoSortStable(graph);

    expect(order).toEqual(['local', 'zeta', 'alpha', 'mid']);
    expect(residue).toEqual([]);
  });

  it('puts a dependency before its dependent regardless of input order', () => {
    const forward = topoSortStable(buildDepGraph(nodes(['a', []], ['b', ['a']])));
    const reversed = topoSortStable(buildDepGraph(nodes(['b', ['a']], ['a', []])));

    expect(forward.order).toEqual(['a', 'b']);
    expect(reversed.order).toEqual(['a', 'b']);
    expect(reversed.residue).toEqual([]);
  });

  it('orders a diamond with index breaking the ties', () => {
    // d depends on b and c; both depend on a. b/c are ready together, so their
    // input index decides which goes first.
    const graph = buildDepGraph(nodes(['d', ['b', 'c']], ['c', ['a']], ['b', ['a']], ['a', []]));

    const { order, residue } = topoSortStable(graph);

    expect(order).toEqual(['a', 'c', 'b', 'd']);
    expect(residue).toEqual([]);
  });

  it('reports both members of a cycle as residue and still orders the rest', () => {
    const graph = buildDepGraph(nodes(['first', []], ['x', ['y']], ['y', ['x']], ['last', ['first']]));

    const { order, residue } = topoSortStable(graph);

    expect(order).toEqual(['first', 'last']);
    expect(residue).toEqual(['x', 'y']);
  });

  it('does not treat a dependency on an absent id as a cycle', () => {
    const graph = buildDepGraph(nodes(['a', ['not-installed']], ['b', []]));

    const { order, residue } = topoSortStable(graph);

    expect(order).toEqual(['a', 'b']);
    expect(residue).toEqual([]);
  });

  it('handles an empty graph', () => {
    expect(topoSortStable(buildDepGraph([]))).toEqual({ order: [], residue: [] });
  });

  it('keeps the first node of a duplicated id, dropping the loser edges', () => {
    expect(topoSortStable(buildDepGraph(nodes(['x', []], ['x', ['y']], ['y', []])))).toEqual({ order: ['x', 'y'], residue: [] });
  });

  it('counts a repeated dependency once', () => {
    expect(topoSortStable(buildDepGraph(nodes(['a', []], ['b', ['a', 'a']])))).toEqual({ order: ['a', 'b'], residue: [] });
  });

  it('treats a self-dependency as a cycle', () => {
    expect(topoSortStable(buildDepGraph(nodes(['a', ['a']])))).toEqual({ order: [], residue: ['a'] });
  });
});

describe('dependentsOf', () => {
  it('lists direct dependents only, in graph order', () => {
    const graph = buildDepGraph(nodes(['a', []], ['b', ['a']], ['c', ['b']], ['d', ['a']]));

    expect(dependentsOf(graph, 'a')).toEqual(['b', 'd']);
    expect(dependentsOf(graph, 'b')).toEqual(['c']);
    expect(dependentsOf(graph, 'c')).toEqual([]);
    expect(dependentsOf(graph, 'not-installed')).toEqual([]);
  });
});

describe('dependentsTeardownOrder', () => {
  it('lists dependents deepest first, which is the reverse of the load order', () => {
    const graph = buildDepGraph(nodes(['a', []], ['b', ['a']], ['c', ['b']], ['d', ['a']]));

    // Load order is a, b, c, d, so teardown is d, c, b: the only hard rule is that
    // nothing goes down after something that depends on it (c before b here).
    expect(dependentsTeardownOrder(graph, 'a')).toEqual(['d', 'c', 'b']);
    expect(dependentsTeardownOrder(graph, 'b')).toEqual(['c']);
    expect(dependentsTeardownOrder(graph, 'c')).toEqual([]);
    expect(dependentsTeardownOrder(graph, 'not-installed')).toEqual([]);
  });

  it('never includes the plugin itself, even when a cycle leads back to it', () => {
    const graph = buildDepGraph(nodes(['x', ['y']], ['y', ['x']], ['z', ['y']]));

    expect(dependentsTeardownOrder(graph, 'x')).toEqual(['z', 'y']);
    expect(dependentsTeardownOrder(graph, 'y')).toEqual(['z', 'x']);
  });
});
