/**
 * A session that started without the Walnut MCP tools gets them at a cold resume
 * whose prompt cache has expired.
 *
 * The mount is decided at a session's first spawn and stored on its record's profile
 * (walnut-mcp-mount.ts), and every resume replays that profile, because the tool list
 * is part of the cached prefix of the conversation behind it. A session spawned before
 * the mount existed (2026-11-01) therefore never got the tools: on 2026-11-09 the
 * Walnut VP, spawned 2026-10-24, resumed with no `--mcp-config` and an init listing
 * `mcp_servers: []`, while its refreshed prompt told it to prefer `mcp__walnut__*`;
 * it ran every op through `walnut tools call` in Bash. Main's leads and dozens of
 * long-lived task sessions were in the same state.
 *
 * When the cache has expired the replay buys nothing (prompt-refresh.ts
 * replayBuysNothing), so the resume takes the mount a fresh start would get, the
 * same decision (withWalnutMcpMount) with the same inputs. A warm cache is never
 * given up for it by a plain resume: the session still reaches Walnut through the CLI
 * meanwhile. A respawn a person asked for (Restart, a rewind, a mode change that needs a
 * new process: SessionRunner.reinitialize) takes the mount whatever the cache, so the
 * user has one way to give a running session its tools now.
 */
import type { SessionProfile, SessionRecord } from '../types.js';
import { isAcpEngine, resolveEngine } from '../agents/engine-registry.js';
import { replayBuysNothing } from './prompt-refresh.js';
import { withWalnutMcpMount, type WalnutMcpMountInput } from './walnut-mcp-mount.js';

export type ResumeMountRecord = Pick<SessionRecord, 'profile'> & Partial<Pick<SessionRecord, 'lane' | 'engine' | 'promptCache'>>;

/**
 * The profile a cold resume of this session should spawn with when it gains the
 * Walnut mount, else null (replay the stored profile as it is).
 */
export function mountOnResume(
  record: ResumeMountRecord,
  input: Omit<WalnutMcpMountInput, 'profile'>,
  now = Date.now(),
  opts: { ignoreCache?: boolean } = {},
): SessionProfile | null {
  if (process.env.WALNUT_MCP_ON_RESUME === '0') return null;
  // A lane (a chat surface) owns its profile; an ACP engine mounts per provider thread.
  if (record.lane || isAcpEngine(resolveEngine(record.engine))) return null;
  if (record.profile?.mcpServers?.walnut) return null;
  if (!opts.ignoreCache && !replayBuysNothing(record.promptCache, now)) return null;
  const next = withWalnutMcpMount({ ...input, profile: record.profile });
  return next?.mcpServers?.walnut ? next : null;
}
