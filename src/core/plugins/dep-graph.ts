/**
 * Plugin dependency graph (pure, no I/O).
 *
 * Ordering rules this file encodes:
 * - A dependency edge only exists between two nodes that are BOTH in the graph.
 *   A node naming an absent id sorts normally; what a missing dependency means is
 *   the caller's decision, not the sort's.
 * - Ties are broken by the node's original `index`, so a graph with no edges comes
 *   back in exactly the input order. That is what lets a dependency-ordered loader
 *   keep today's discovery order until real edges exist.
 * - A cycle is reported as `residue` rather than guessed at: no order satisfies it.
 *
 * `order` is sorted by `index` within each ready set; `residue` is in graph
 * insertion order, since a cycle has no meaningful index ordering to report.
 */

export interface DepGraphNode {
  id: string;
  index: number;
  deps: string[];
}

export interface DepGraph {
  /** Nodes by id, in input order. */
  nodes: Map<string, DepGraphNode>;
  /** id → ids that directly depend on it. */
  dependents: Map<string, Set<string>>;
}

export function buildDepGraph(nodes: readonly DepGraphNode[]): DepGraph {
  const byId = new Map<string, DepGraphNode>();
  // First occurrence wins, matching the loader's first-wins precedence on ids.
  for (const node of nodes) if (!byId.has(node.id)) byId.set(node.id, node);

  const dependents = new Map<string, Set<string>>();
  for (const node of byId.values()) {
    for (const dep of new Set(node.deps)) {
      if (!byId.has(dep)) continue;
      let set = dependents.get(dep);
      if (!set) { set = new Set(); dependents.set(dep, set); }
      set.add(node.id);
    }
  }
  return { nodes: byId, dependents };
}

/** Kahn's algorithm; ready nodes are drained in `index` order. */
export function topoSortStable(graph: DepGraph): { order: string[]; residue: string[] } {
  const indegree = new Map<string, number>();
  for (const node of graph.nodes.values()) {
    let count = 0;
    for (const dep of new Set(node.deps)) if (graph.nodes.has(dep)) count++;
    indegree.set(node.id, count);
  }

  const indexOf = (id: string) => graph.nodes.get(id)?.index ?? 0;
  const ready: string[] = [];
  const pushReady = (id: string) => {
    const at = ready.findIndex((other) => indexOf(other) > indexOf(id));
    if (at < 0) ready.push(id); else ready.splice(at, 0, id);
  };
  for (const node of graph.nodes.values()) if (indegree.get(node.id) === 0) pushReady(node.id);

  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of graph.dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) pushReady(dependent);
    }
  }

  const emitted = new Set(order);
  const residue = [...graph.nodes.keys()].filter((id) => !emitted.has(id));
  return { order, residue };
}

/** Direct dependents of `id`, in graph order. */
export function dependentsOf(graph: DepGraph, id: string): string[] {
  const set = graph.dependents.get(id);
  if (!set) return [];
  return [...graph.nodes.keys()].filter((candidate) => set.has(candidate));
}
