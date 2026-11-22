/**
 * Which Walnut tools a host's MCP server lists for its session (experiment mcp_tools_by_role):
 * the session's role, read from its task (src/ops/op-groups.ts ROLE_LISTINGS).
 *
 * Asked by the gateway's `tools.list {schemas: true, listing: 'role'}` (capability-router.ts),
 * which only a host server that tells its session how to reach the rest sends. Undefined means
 * "list everything", today's catalog: the experiment off, an outside caller, a session or task
 * Walnut does not know, a router (held to its own ops by router/gateway-policy.ts), or any
 * failure to read them. LISTING ONLY: what a role does not list still runs by name.
 *
 * The hub's own mount (`open-walnut mcp`, Main and the asks on this machine) has no caller id at
 * listing time; it reads its role from WALNUT_MCP_ROLE instead (core/sessions/profiles.ts).
 */
import type { SessionRecord } from '../types.js';
import type { ListingRole, ToolListing } from '../../ops/op-groups.js';
import { keepsThreads } from '../org/keeps-threads.js';

/** The fields of a task that decide its role (a Task, or the prompt builder's slice of one). */
export type ListingTask = { org_role?: string; threads_on?: boolean; walnut_agent?: boolean; source?: string };

export interface ToolListingDeps {
  flagOn(): Promise<boolean>;
  session(sid: string): Promise<Pick<SessionRecord, 'taskId'> | null>;
  task(id: string): Promise<ListingTask | undefined>;
}

const defaultDeps: ToolListingDeps = {
  async flagOn() {
    const [{ getConfig }, { experimentalEnabled }, { ROLE_LISTING_EXPERIMENT }] = await Promise.all([
      import('../config-manager.js'), import('../experimental.js'), import('../../ops/op-groups.js'),
    ]);
    return experimentalEnabled((await getConfig()).experimental, ROLE_LISTING_EXPERIMENT);
  },
  async session(sid) {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    return getSessionByClaudeId(sid);
  },
  async task(id) {
    const { getTask } = await import('../task-manager.js');
    const task = await getTask(id);
    return task.id === id ? task : undefined;
  },
};

/** The role a task's session lists tools for, or undefined to list everything (pure). */
export function listingRoleOfTask(task: ListingTask): ListingRole | undefined {
  if (task.org_role === 'main' || task.org_role === 'lead') return 'org';
  if (task.org_role) return undefined;
  // An Ask of the Personal AI speaks as Main does (its persona names the org's tools).
  if (task.walnut_agent) return 'org';
  return keepsThreads(task) ? 'thread_keeper' : 'worker';
}

/**
 * What a task's session lists (pure): its role, and the plugin its task comes from (Task.source:
 * the plugin that syncs its project), whose tools a worker lists too (op-groups.ts ROLE_LISTINGS).
 */
export function toolListingOfTask(task: ListingTask): ToolListing | undefined {
  const role = listingRoleOfTask(task);
  if (!role) return undefined;
  const source = typeof task.source === 'string' ? task.source.trim() : '';
  return source && source !== 'local' ? { role, plugins: [source] } : { role };
}

/** The caller's listing, or undefined to list everything. Never throws. */
export async function listingRoleForCaller(callerSid: string, deps: ToolListingDeps = defaultDeps): Promise<ToolListing | undefined> {
  try {
    if (!callerSid || callerSid === 'external' || !(await deps.flagOn())) return undefined;
    const record = await deps.session(callerSid);
    if (!record?.taskId) return undefined;
    const task = await deps.task(record.taskId);
    return task ? toolListingOfTask(task) : undefined;
  } catch {
    return undefined;
  }
}
