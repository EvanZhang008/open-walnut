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
 * The honest inventory of what the Walnut agent does WITHOUT being asked —
 * every `fastModelFor`/`sendMessage` caller under src/core, named in the user's
 * terms. Keeping it in the UI is the point: "what does Walnut do behind my
 * back, and what answers it" was previously unanswerable from Settings.
 *
 * `runner: 'jev'` marks a job Jev can take over (a one-field classification);
 * the rest are text jobs that need a language model.
 */
const AGENT_JOBS: Array<{ name: string; detail: string; runner: 'jev' | 'model' }> = [
  { name: 'Quick-add task parsing', detail: 'Turns a typed note into a title, tier, priority and project.', runner: 'jev' },
  { name: 'Session auto-filing', detail: 'Files a quick-start session’s task into the best-matching project.', runner: 'jev' },
  { name: 'Session titles', detail: 'Names a session from its first turns.', runner: 'model' },
  { name: 'Conversation and fork titles', detail: 'Names a chat conversation, and a fork from the turn it branched at.', runner: 'model' },
  { name: 'Project summaries', detail: 'Keeps a one-line description of each project as its tasks accumulate.', runner: 'model' },
  { name: 'Task ledger notes', detail: 'Writes the short description a task carries after a session works on it.', runner: 'model' },
  { name: 'Memory upkeep', detail: 'Maintains working memory and the standing overview injected into chats.', runner: 'model' },
  { name: 'Diff summaries', detail: 'Explains what a session changed, per file.', runner: 'model' },
  { name: 'AI task search', detail: 'Answers a search query that needs reading tasks, not just matching words.', runner: 'model' },
  { name: 'Routine drafts and watchers', detail: 'Drafts a routine from a description; runs a watcher’s check script decision.', runner: 'model' },
];

/**
 * Ask Walnut — the Walnut agent, in one section: the chat you talk to, plus
 * every job it does on its own.
 *
 * Two runners, and the split follows from the WORK, not from taste:
 *   - a CONVERSATION needs tools, a working directory and a persona, so it runs
 *     on an engine (a lane session: one long-lived coding-agent CLI per
 *     conversation, personal-ai-lane.ts);
 *   - the SMALL JOBS are one prompt in, strict JSON out, so they are single API
 *     calls. Spawning a whole coding agent per keystroke is what the Jev work
 *     measured as hopeless (it hit the 10s timeout every time).
 */
export function AskWalnutSection({ config, onSave }: Props) {
  const catalog = useEngineCatalog();
  const hydration = useEngineCatalogHydration();
  const ready = defaultEnginePickerReady(hydration);

  const explicit = config.agent?.chat_engine;
  const options = defaultEngineOptions(catalog, explicit ?? 'claude');
  const claudeLabel = catalog.find((e) => e.id === 'claude')?.displayName ?? 'Claude Code';
  const degraded = explicit ? lacksPersona(catalog, explicit) : false;

  const jevOn = Boolean(config.jev?.api_key || config.providers?.openrouter?.api_key);
  const backgroundProvider = config.agent?.main_provider;

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
      description="The Walnut agent: the chat you talk to, plus the small jobs it does on its own. A conversation runs as a real session on a coding-agent engine; the small jobs are single API calls, which is why they have their own model."
      showSave={false}
    >
      <div className="form-group">
        <label htmlFor="ask-walnut-engine">Conversation engine</label>
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
            ? 'Applies to new conversations; an open one keeps the engine it started on. The engine’s own account and model settings live under Engines, and coding sessions have their own default there.'
            : 'Checking which engines are installed on this machine…'}
        </p>
        {degraded && (
          <p className="text-sm" style={{ marginTop: 4, color: 'var(--warning, #b45309)' }} data-testid="ask-walnut-degraded">
            This engine answers without Walnut&apos;s persona, skills index and memory: it has no
            system-prompt channel, so chat behaves like a plain chat with that provider.
          </p>
        )}
      </div>

      <div className="form-group" data-testid="ask-walnut-jobs">
        <label>What it does on its own</label>
        <p className="text-sm text-muted" style={{ marginTop: 2, marginBottom: 8 }}>
          Each of these is one call, never a conversation, and none of them reads your chat history.
        </p>
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 7 }}>
          {AGENT_JOBS.map((job) => {
            const onJev = job.runner === 'jev' && jevOn;
            return (
              <li key={job.name} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                <span
                  className="text-sm"
                  style={{
                    flex: '0 0 68px',
                    textAlign: 'right',
                    color: onJev ? 'var(--accent, #1d4ed8)' : 'var(--text-muted, #6b7280)',
                    fontWeight: onJev ? 600 : 400,
                  }}
                >
                  {onJev ? 'Jev' : 'model'}
                </span>
                <span>
                  <span style={{ fontWeight: 600 }}>{job.name}</span>
                  <span className="text-sm text-muted"> — {job.detail}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="form-group">
        <label>Which model answers them</label>
        <p className="text-sm text-muted" style={{ marginTop: 2 }}>
          The <em>model</em> rows run on{' '}
          {backgroundProvider
            ? <strong>{backgroundProvider}</strong>
            : <>whichever provider is configured</>}{' '}
          (<a href="#providers">pick the provider and manage its key</a>).{' '}
          {jevOn
            ? <>The <em>Jev</em> rows run on TypeSafe’s decision model instead: a few hundred milliseconds, fractions of a cent (<a href="#jev">Jev Decisions</a>).</>
            : <>The classification rows can run on TypeSafe’s decision model instead, which is far faster and cheaper for a one-field answer (<a href="#jev">Jev Decisions</a>).</>}
        </p>
      </div>
    </SectionCard>
  );
}
