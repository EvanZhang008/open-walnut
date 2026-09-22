import type { Config, SessionEngine } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { useEngineCatalog, useEngineCatalogHydration } from '@/hooks/useEngineCatalog';
import { defaultEngineOptions, defaultEnginePickerReady } from './default-engine-select';
import { log } from '@/utils/log';

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

/** Sentinel for "no explicit choice" — chat then runs on Claude Code. */
const UNSET = '';
/** Engines with no system-prompt channel: a chat lane on one answers without
 *  Walnut's persona, skills index and memory block. Mirrors isAcpEngine
 *  server-side; kept as a capability read off the catalog, not a name list. */
function lacksPersona(catalog: ReturnType<typeof useEngineCatalog>, id: string): boolean {
  return catalog.find((e) => e.id === id)?.runtimeKind === 'acp';
}

/**
 * Ask Walnut: which ENGINE answers your chat conversations.
 *
 * Chat runs on a lane session — one long-lived coding-agent CLI per
 * conversation (personal-ai-lane.ts) — so the only question here is which
 * engine that is. It is NOT a model/provider question: an engine brings its own
 * account and model settings (Settings > Engines edits those files), and the
 * model calls WALNUT makes for itself live under Background Model.
 *
 * Unset means Claude Code. Deliberately NOT "follow defaults.engine": that
 * knob steers coding sessions, and an ACP engine has no system-prompt channel,
 * so a lane on one answers without the persona, the skills index or the memory
 * block. Chat opts into another engine explicitly, with that cost stated.
 */
export function AskWalnutSection({ config, onSave }: Props) {
  const catalog = useEngineCatalog();
  const hydration = useEngineCatalogHydration();
  const ready = defaultEnginePickerReady(hydration);

  const explicit = config.agent?.chat_engine;
  const options = defaultEngineOptions(catalog, explicit ?? 'claude');
  const claudeLabel = catalog.find((e) => e.id === 'claude')?.displayName ?? 'Claude Code';
  const degraded = explicit ? lacksPersona(catalog, explicit) : false;

  const handleChange = async (value: string) => {
    try {
      await onSave({
        // Spread ...config.agent: updateConfig replaces the whole `agent` key,
        // so every sibling (main_provider, language, effort…) must ride along.
        agent: {
          ...config.agent,
          ...(value === UNSET
            ? { chat_engine: undefined }
            : { chat_engine: value as SessionEngine }),
        },
      });
    } catch (err) {
      log.error('settings', 'ask walnut engine save failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <SectionCard
      id="ask-walnut"
      title="Ask Walnut"
      description="Your chat with Walnut runs on a real coding-agent session, one per conversation. This picks which engine answers. The engine brings its own account and model settings (edit those under Engines); the model Walnut calls for its own small jobs is under Background Model."
      showSave={false}
    >
      <div className="form-group">
        <label htmlFor="ask-walnut-engine">Engine</label>
        <select
          id="ask-walnut-engine"
          value={explicit ?? UNSET}
          onChange={(e) => void handleChange(e.target.value)}
          disabled={!ready}
          data-testid="ask-walnut-engine"
        >
          <option value={UNSET}>{claudeLabel} (default)</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
        <p className="text-sm text-muted" style={{ marginTop: 2 }}>
          {ready
            ? 'Applies to new conversations; an open conversation keeps the engine it started on. Coding sessions have their own default under Engines.'
            : 'Checking which engines are installed on this machine…'}
        </p>
        {degraded && (
          <p className="text-sm" style={{ marginTop: 4, color: 'var(--warning, #b45309)' }} data-testid="ask-walnut-degraded">
            This engine answers without Walnut&apos;s persona, skills index and memory: it has no
            system-prompt channel, so chat behaves like a plain chat with that provider.
          </p>
        )}
      </div>
    </SectionCard>
  );
}
