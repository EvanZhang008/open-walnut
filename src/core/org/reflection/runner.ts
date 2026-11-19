/**
 * The reflection's clock: every few minutes, one pass for each open node with the switch on
 * (duties/reflection.duty.ts), one node at a time, never two passes at once. The
 * switch is read at each pass, so turning it on or off needs no restart; a node seen on for the
 * first time starts from now (state.ts `since`), never from its history.
 */
import { log } from '../../../logging/index.js';
import { orgDisplayTitle } from '../org-tree.js';

export const PASS_EVERY_MS = 5 * 60_000;
const FIRST_PASS_MS = 2 * 60_000;

let running = false;

/** One pass over every node with reflection on. Returns how many findings it made. */
export async function reflectionPass(): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const [{ nodesWithDuty }, { orgTasks }, { reflectForNode, defaultDeps }, { isOrgEnabled }] = await Promise.all([
      import('../duties/node-duties.js'), import('../org-store.js'), import('./pipeline.js'), import('../org-enabled.js'),
    ]);
    // With the org off (Settings › Org) no duty runs: no model call, no correction.
    if (!(await isOrgEnabled())) return 0;
    const nodes = await nodesWithDuty('reflection');
    if (!nodes.length) return 0;
    const all = await orgTasks();
    const deps = defaultDeps();
    let findings = 0;
    for (const node of nodes) {
      try {
        const r = await reflectForNode(node, orgDisplayTitle(node), all, deps);
        findings += r.findings.filter((f) => f.verdict.verdict === 'bad_decision').length;
        if (r.candidates) log.task.info('reflection: pass', { nodeId: node.id, candidates: r.candidates, judged: r.judged, findings });
      } catch (err) {
        log.task.warn('reflection: pass failed for a node', { nodeId: node.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return findings;
  } finally {
    running = false;
  }
}

/** Start the clock; returns its stop. */
export function startReflectionRunner(): () => void {
  const tick = () => { void reflectionPass().catch(() => {}); };
  const first = setTimeout(tick, FIRST_PASS_MS);
  const every = setInterval(tick, PASS_EVERY_MS);
  first.unref?.();
  every.unref?.();
  return () => { clearTimeout(first); clearInterval(every); };
}
