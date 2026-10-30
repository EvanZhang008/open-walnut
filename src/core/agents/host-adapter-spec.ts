/**
 * An ACP engine's adapter as another host resolves it (providers/acp-host-artifacts.ts):
 * what the primary sends instead of the paths of its own install.
 */
import type { SessionEngine } from '../types.js';
import type { AcpHostAdapterSpec } from '../../providers/acp-host-artifacts.js';
import { engineCaps } from './engine-registry.js';
import { enginePathOverrideVar } from './engine-probe.js';

/** The host files a bundled adapter runs from (ACP_HOST_FILES), and the env it reads its CLI from. */
const HOST_BUNDLED_ADAPTERS: Partial<Record<SessionEngine, { bundle: string; binaryEnv: string }>> = {
  codex: { bundle: 'codex-acp.mjs', binaryEnv: 'CODEX_PATH' },
  pi: { bundle: 'pi-acp.mjs', binaryEnv: 'PI_ACP_PI_COMMAND' },
};

/**
 * The spec, or null when the engine cannot run anywhere but here: the custom
 * engine's command is this machine's config, and Claude Code is no ACP engine.
 */
export function hostAdapterSpec(engine: SessionEngine): AcpHostAdapterSpec | null {
  const caps = engineCaps(engine);
  const adapter = caps.acpAdapter;
  if (!adapter || adapter.source === 'config' || !adapter.binary) return null;
  const bundled = adapter.source === 'bundled' ? HOST_BUNDLED_ADAPTERS[caps.id] : undefined;
  if (adapter.source === 'bundled' && !bundled) return null;
  return {
    engine: caps.id, displayName: caps.displayName, source: adapter.source, binary: adapter.binary,
    args: adapter.args ? [...adapter.args] : null, overrideEnv: enginePathOverrideVar(caps.id),
    versionArgs: [...(adapter.versionArgs ?? [])],
    ...(bundled ? { bundle: bundled.bundle, binaryEnv: bundled.binaryEnv } : {}),
  };
}
