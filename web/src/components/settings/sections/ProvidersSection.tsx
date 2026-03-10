import { useState, useEffect, useCallback } from 'react';
import type { Config } from '@walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { SecretInput } from '../inputs/SecretInput';
import { StatusIndicator } from '../inputs/StatusIndicator';
import { fetchProviders, testProvider, type ProviderStatus, type TestConnectionResult } from '@/api/config';

// All known providers — shown as a catalog. User fills in API key to enable.
const ALL_PROVIDERS: { name: string; label: string; api: string; base_url?: string; needsKey: boolean }[] = [
  { name: 'bedrock', label: 'AWS Bedrock', api: 'bedrock', needsKey: false },
  { name: 'anthropic', label: 'Anthropic', api: 'anthropic-messages', needsKey: true },
  { name: 'openai', label: 'OpenAI', api: 'openai-chat', needsKey: true },
  { name: 'openrouter', label: 'OpenRouter', api: 'openai-chat', base_url: 'https://openrouter.ai/api/v1', needsKey: true },
  { name: 'deepseek', label: 'DeepSeek', api: 'openai-chat', base_url: 'https://api.deepseek.com/v1', needsKey: true },
  { name: 'together', label: 'Together AI', api: 'openai-chat', base_url: 'https://api.together.xyz/v1', needsKey: true },
  { name: 'gemini', label: 'Google Gemini', api: 'google-generative-ai', needsKey: true },
  { name: 'ollama', label: 'Ollama (Local)', api: 'ollama', needsKey: false },
  { name: 'moonshot', label: 'Moonshot', api: 'openai-chat', base_url: 'https://api.moonshot.cn/v1', needsKey: true },
  { name: 'qwen', label: 'Qwen (Tongyi)', api: 'openai-chat', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', needsKey: true },
  { name: 'doubao', label: 'Doubao (ByteDance)', api: 'openai-chat', base_url: 'https://ark.cn-beijing.volces.com/api/v3', needsKey: true },
  { name: 'nvidia', label: 'NVIDIA NIM', api: 'openai-chat', base_url: 'https://integrate.api.nvidia.com/v1', needsKey: true },
];

const PROTOCOL_LABELS: Record<string, string> = {
  'anthropic-messages': 'Anthropic Messages API',
  'openai-chat': 'OpenAI-compatible',
  'bedrock': 'AWS Bedrock',
  'google-generative-ai': 'Google Generative AI',
  'ollama': 'Local Ollama',
};

// Truncate long error messages (e.g. raw JSON from 401 responses)
function truncateError(msg: string, max = 80): string {
  if (msg.length <= max) return msg;
  return msg.slice(0, max) + '...';
}

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

function ProviderCard({
  def,
  isActive,
  serverInfo,
  configApiKey,
  onSaveKey,
}: {
  def: typeof ALL_PROVIDERS[number];
  isActive?: boolean;
  serverInfo?: ProviderStatus;
  configApiKey?: string;
  onSaveKey: (name: string, key: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [apiKey, setApiKey] = useState(configApiKey ?? '');
  const [saving, setSaving] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [testMsg, setTestMsg] = useState<string | undefined>();

  // Sync from config changes
  useEffect(() => { setApiKey(configApiKey ?? ''); }, [configApiKey]);

  const isConfigured = !!(serverInfo?.status === 'ready');
  const isEnv = !!(serverInfo?.auto_detected && isConfigured);
  const hasKey = !!(serverInfo?.key_hint || configApiKey);

  const handleTest = async () => {
    setTestStatus('testing');
    setTestMsg(undefined);
    try {
      const result: TestConnectionResult = await testProvider(def.name);
      if (result.ok) {
        setTestStatus('ok');
        setTestMsg(`Connected${result.latencyMs ? ` (${result.latencyMs}ms)` : ''}`);
      } else {
        setTestStatus('error');
        setTestMsg(truncateError(result.error ?? 'Connection failed'));
      }
    } catch (err) {
      setTestStatus('error');
      setTestMsg(truncateError((err as Error).message));
    }
  };

  const handleSaveKey = async () => {
    setSaving(true);
    try {
      await onSaveKey(def.name, apiKey.trim());
    } finally {
      setSaving(false);
    }
  };

  // Status display
  let statusDot: 'connected' | 'error' | 'unknown' = 'unknown';
  let statusLabel = 'Not configured';
  if (testStatus === 'ok') { statusDot = 'connected'; statusLabel = testMsg!; }
  else if (testStatus === 'error') { statusDot = 'error'; statusLabel = testMsg!; }
  else if (testStatus === 'testing') { statusDot = 'unknown'; statusLabel = 'Testing...'; }
  else if (isConfigured) { statusDot = 'connected'; statusLabel = isEnv ? 'Ready (env)' : 'Ready'; }
  else if (!def.needsKey) { statusDot = 'connected'; statusLabel = 'Available'; }

  const envKeyName = `${def.name.toUpperCase().replace(/-/g, '_')}_API_KEY`;

  return (
    <div className="provider-card">
      <div className="provider-card-header" onClick={() => setExpanded(!expanded)}>
        <div className="provider-card-left">
          <span className="provider-card-arrow">{expanded ? '▾' : '▸'}</span>
          <span className="provider-card-label">{def.label}</span>
          {isActive && <span className="provider-badge active">active</span>}
          {isEnv && <span className="provider-badge auto">env</span>}
          {hasKey && !isEnv && <span className="provider-badge configured">key</span>}
        </div>
        <div className="provider-card-right" onClick={(e) => e.stopPropagation()}>
          <StatusIndicator status={statusDot} text={statusLabel} />
          {isConfigured && (
            <button type="button" className="btn btn-sm" onClick={handleTest} disabled={testStatus === 'testing'}>
              {testStatus === 'testing' ? '...' : 'Test'}
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="provider-card-body">
          <div className="provider-card-meta">
            <span>Protocol: {PROTOCOL_LABELS[def.api] ?? def.api}</span>
            {def.base_url && <span>URL: {def.base_url}</span>}
          </div>

          {def.needsKey && (
            <div className="provider-card-key-row">
              <div className="form-group" style={{ margin: 0, flex: 1 }}>
                <label htmlFor={`key-${def.name}`}>API Key</label>
                <SecretInput
                  id={`key-${def.name}`}
                  value={apiKey}
                  onChange={setApiKey}
                  placeholder={isEnv ? `Configured via ${envKeyName}` : `Paste ${envKeyName}`}
                />
                {isEnv && !configApiKey && (
                  <p className="text-sm text-muted" style={{ marginTop: 2 }}>
                    Detected from <code style={{ fontSize: 11 }}>{envKeyName}</code>. Paste a key above to override.
                  </p>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', paddingBottom: 2 }}>
                <button
                  type="button" className="btn btn-primary btn-sm"
                  onClick={handleSaveKey} disabled={saving || !apiKey.trim()}
                >
                  {saving ? 'Saving...' : 'Save Key'}
                </button>
                {!isConfigured && apiKey.trim() && (
                  <button type="button" className="btn btn-sm" onClick={handleTest} disabled={testStatus === 'testing'}>
                    Test
                  </button>
                )}
              </div>
            </div>
          )}

          {!def.needsKey && (
            <p className="text-sm text-muted">
              {def.api === 'bedrock'
                ? 'Authentication is managed via the Getting Started section above (bearer token or AWS credentials).'
                : 'No API key required — connects to local server.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function ProvidersSection({ config, onSave }: Props) {
  const [providers, setProviders] = useState<Record<string, ProviderStatus>>({});
  const [loading, setLoading] = useState(true);
  const activeProvider = config.agent?.main_provider ?? 'bedrock';

  const loadProviders = useCallback(async () => {
    try {
      const data = await fetchProviders();
      setProviders(data);
    } catch {
      // API not available yet (old server) — show all as unconfigured
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadProviders(); }, [loadProviders]);

  const handleSaveKey = async (name: string, key: string) => {
    const existing = config.providers ?? {};
    const template = ALL_PROVIDERS.find(p => p.name === name);
    const current = existing[name] ?? {};
    const updated = {
      ...existing,
      [name]: {
        ...current,
        api: template?.api ?? 'openai-chat',
        ...(template?.base_url ? { base_url: template.base_url } : {}),
        ...(key ? { api_key: key } : {}),
      },
    };
    await onSave({ providers: updated });
    await loadProviders();
  };

  const handleSetActive = async (name: string) => {
    await onSave({ agent: { ...config.agent, main_provider: name } });
  };

  // Providers that are ready (have keys or don't need them) — used for active dropdown.
  // Exclude not_implemented providers (e.g. ollama) that can't actually serve requests.
  const readyProviders = ALL_PROVIDERS.filter(
    (def) => {
      const info = providers[def.name];
      if (info?.status === 'not_implemented') return false;
      return info?.status === 'ready' || !def.needsKey;
    },
  );

  return (
    <SectionCard
      id="providers"
      title="AI Providers"
      description="All supported providers are listed below. Enter an API key to enable a provider."
      showSave={false}
    >
      {/* Active provider selector */}
      <div className="form-group" style={{ marginBottom: 20 }}>
        <label htmlFor="active-provider">Active Provider</label>
        <select
          id="active-provider"
          value={activeProvider}
          onChange={(e) => handleSetActive(e.target.value)}
        >
          {readyProviders.map((def) => (
            <option key={def.name} value={def.name}>{def.label}</option>
          ))}
        </select>
        <p className="text-sm text-muted" style={{ marginTop: 4 }}>
          The provider used by the main agent for chat and task processing.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-muted">Loading providers...</p>
      ) : (
        <div className="provider-catalog">
          {ALL_PROVIDERS.map((def) => (
            <ProviderCard
              key={def.name}
              def={def}
              isActive={def.name === activeProvider}
              serverInfo={providers[def.name]}
              configApiKey={(config.providers as Record<string, { api_key?: string }> | undefined)?.[def.name]?.api_key}
              onSaveKey={handleSaveKey}
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}
