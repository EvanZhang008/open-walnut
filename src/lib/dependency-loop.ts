/**
 * Whether `from` depends on `target`, directly or through other tasks: the one rule that makes
 * "target depends on from" a loop. The server refuses such a write (task-manager.ts
 * checkCircularDependency) and the task detail's dependency picker leaves such a task out, so
 * the person is never offered a pick that can only fail.
 */
export function dependsOnThrough(
  tasks: readonly { id: string; depends_on?: readonly string[] | null }[],
  from: string,
  target: string,
): boolean {
  const depsOf = new Map(tasks.map((t) => [t.id, t.depends_on ?? []]))
  const seen = new Set<string>()
  const queue = [from]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current === target) return true
    if (seen.has(current)) continue
    seen.add(current)
    for (const next of depsOf.get(current) ?? []) if (!seen.has(next)) queue.push(next)
  }
  return false
}
