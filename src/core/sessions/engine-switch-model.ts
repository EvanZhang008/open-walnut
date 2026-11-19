/**
 * A switch to an ACP engine with a model named: the model must be one that engine's
 * menu offers on this Mac, or the switch is refused right there, saying so. Before
 * this, a pick the endpoint did not serve started the new session anyway, and the
 * person learned of it only from a 404 on his first message (2026-11-18, a task
 * switched to Codex on openai.gpt-6.2-sol, which the local proxy does not serve).
 *
 * Only on this Mac (another host's menu is that host's) and only when the menu is at
 * hand within a short wait: a menu that cannot be read never blocks a switch.
 */

import { isAcpEngine, engineCaps } from '../agents/engine-registry.js';
import type { SessionEngine } from '../types.js';

const MENU_WAIT_MS = 8_000;

export class ModelNotOfferedError extends Error {
  constructor(message: string, readonly offered: string[]) {
    super(message);
    this.name = 'ModelNotOfferedError';
  }
}

const baseOf = (id: string): string => id.replace(/\[[^\]]*\]$/, '');

/** Throws ModelNotOfferedError when `model` is not in the engine's menu; quiet when the menu cannot be read. */
export async function checkSwitchModelOffered(
  engine: SessionEngine,
  model: string | undefined,
  options: { cwd?: string; local: boolean; readMenu?: (engine: SessionEngine, cwd?: string) => Promise<{ models: Array<{ modelId: string }> }> },
): Promise<void> {
  if (!model || !options.local || !isAcpEngine(engine)) return;
  const read = options.readMenu ?? (async (e: SessionEngine, cwd?: string) =>
    (await import('../../providers/engine-model-probe.js')).getEngineModelCatalog(e, { cwd }));
  let models: Array<{ modelId: string }>;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const menu = await Promise.race([
      read(engine, options.cwd),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), MENU_WAIT_MS); }),
    ]).finally(() => clearTimeout(timer));
    if (!menu) return;
    models = menu.models;
  } catch {
    return;
  }
  if (models.length === 0) return;
  if (models.some((m) => m.modelId === model || baseOf(m.modelId) === baseOf(model))) return;
  const offered = [...new Set(models.map((m) => baseOf(m.modelId)))];
  throw new ModelNotOfferedError(
    `${engineCaps(engine).displayName} does not offer ${baseOf(model)} here: the endpoint it goes through does not serve it. `
    + `Pick one of: ${offered.join(', ')}.`,
    offered,
  );
}
