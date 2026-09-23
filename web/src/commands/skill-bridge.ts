/**
 * Skill bridge: loads skills (workspace / walnut / claude / builtin / plugin-registered
 * — every source the server-side skill loader discovers) into the frontend command
 * registry so the main-chat "/" palette shows skills alongside commands.
 *
 * Selecting a skill sends the agent an instruction to apply that skill —
 * the agent already has the skill list in its system prompt, so naming it
 * is enough for it to load and follow the SKILL.md.
 *
 * Registered under the 'skill' owner, the lowest-priority tier: a command of the same
 * name always wins, and refreshing skills can never disturb a command.
 */
import { registerOwned, removeOwner } from './registry.js';
import { fetchSkills } from '@/api/skills';
import type { SlashCommand } from './types.js';

interface SkillLoad {
  promise: Promise<void>;
  /** When the request left the admission queue (performance.now clock); null while
   *  it still waits. From that moment the server may already have read the skill
   *  list, so a change made later is not guaranteed to be in the answer. */
  dispatchedAt: number | null;
}

let inFlight: SkillLoad | null = null;
let trailing: Promise<void> | null = null;
/** Dispatch time of the read whose answer the palette holds now (null: none yet). */
let installedFrom: number | null = null;

function startLoad(): SkillLoad {
  const load: SkillLoad = { promise: Promise.resolve(), dispatchedAt: null };
  load.promise = (async () => {
    try {
      // Low priority: the palette is not open while this loads (see api/client).
      const skills = await fetchSkills({ priority: 'low', onDispatch: () => { load.dispatchedAt = performance.now(); } });
      // Swap only once fresh data is in hand: a failed refresh keeps the old
      // entries instead of leaving the palette with no skills at all.
      removeOwner('skill');
      for (const skill of skills) {
        if (!skill.eligible || !skill.enabled) continue;

        const cmd: SlashCommand = {
          name: skill.name,
          description: skill.description || `Apply the ${skill.name} skill`,
          type: 'agent',
          source: 'skill',
          execute: (ctx) => {
            const parts = [`Apply your "${skill.name}" skill (${skill.location}) now.`];
            if (ctx.args) parts.push(`Request: ${ctx.args}`);
            ctx.sendMessage(parts.join(' '));
          },
        };
        registerOwned('skill', cmd);
      }
      installedFrom = load.dispatchedAt;
    } catch {
      // Server may not be up yet — palette just shows commands only. The next
      // socket connect (plugins/loader) asks again.
    }
  })();
  load.promise.finally(() => { if (inFlight === load) inFlight = null; });
  return load;
}

/**
 * Load (or reload) the skill entries of the "/" palette so they include every
 * change made up to `changedAt` (default: now). Callers share reads instead of
 * each fetching the list (1.2MB): a page load asked three times (commands/index.ts,
 * the plugin loader's first run, the first socket connect), 2026-09-23.
 *   - the answer already installed came from a read that left after `changedAt`:
 *     nothing to do (the first socket connect, when index.ts's read left after it);
 *   - a read still waiting in the admission queue, or one that left after
 *     `changedAt`, will include the change: join it;
 *   - a read that left before `changedAt` may predate it: one more read after it,
 *     shared by everyone who asks meanwhile.
 */
export function loadSkillCommands(opts?: { changedAt?: number }): Promise<void> {
  const changedAt = opts?.changedAt ?? performance.now();
  if (installedFrom !== null && installedFrom >= changedAt) return Promise.resolve();
  if (inFlight && (inFlight.dispatchedAt === null || inFlight.dispatchedAt >= changedAt)) return inFlight.promise;
  if (inFlight) {
    trailing ??= inFlight.promise.then(() => {
      trailing = null;
      return loadSkillCommands();
    });
    return trailing;
  }
  inFlight = startLoad();
  return inFlight.promise;
}

/** Same as loadSkillCommands: every load replaces the 'skill' entries atomically. */
export function refreshSkillCommands(opts?: { changedAt?: number }): Promise<void> {
  return loadSkillCommands(opts);
}

/** Test hook — forget what the palette holds (a fresh page). */
export function resetSkillBridgeForTesting(): void {
  inFlight = null;
  trailing = null;
  installedFrom = null;
}
