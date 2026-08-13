import { useState, useEffect, useCallback } from 'react';
import type { Config } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { SecretInput } from '../inputs/SecretInput';
import { StatusIndicator } from '../inputs/StatusIndicator';
import { NumberInput } from '../inputs/NumberInput';
import { fetchProviders, fetchAwsProfiles, testProvider, testConnection, fetchCredentialTrace, type ProviderStatus, type TestConnectionResult, type ModelEntry, type CredentialTrace, type CredentialVerify } from '@/api/config';
import { InstallButton } from '@/components/common/InstallButton';

// Providers we actively test and support.
// `api` matches ProviderConfig.api (the ApiProtocol union). Typing the field as the union
// (not `string`) lets `template.api` assign cleanly into ProviderConfig without widening,
// while keeping `base_url` optional across all entries (an `as const` tuple would drop it).
type ProviderApi = 'anthropic-messages' | 'openai-chat' | 'bedrock' | 'google-generative-ai' | 'ollama' | 'claude-cli';
const ALL_PROVIDERS: { name: string; label: string; api: ProviderApi; base_url?: string; needsKey: boolean }[] = [
  { name: 'bedrock', label: 'AWS Bedrock', api: 'bedrock', needsKey: false },
  { name: 'anthropic', label: 'Anthropic', api: 'anthropic-messages', needsKey: true },
  { name: 'claude_cli', label: 'Claude Code Subscription', api: 'claude-cli', needsKey: false },
  { name: 'openai', label: 'OpenAI', api: 'openai-chat', needsKey: true },
  { name: 'openrouter', label: 'OpenRouter', api: 'openai-chat', base_url: 'https://openrouter.ai/api/v1', needsKey: true },
  { name: 'gemini', label: 'Google Gemini', api: 'google-generative-ai', needsKey: true },
  { name: 'ollama', label: 'Ollama (Local)', api: 'ollama', needsKey: false },
];

const BEDROCK_REGIONS = [
  'us-west-2', 'us-east-1', 'us-east-2',
  'eu-west-1', 'eu-west-3',
  'ap-southeast-1', 'ap-northeast-1',
];

const PROTOCOL_LABELS: Record<string, string> = {
  'anthropic-messages': 'Anthropic Messages API',
  'openai-chat': 'OpenAI-compatible',
  'bedrock': 'AWS Bedrock',
  'google-generative-ai': 'Google Generative AI',
  'ollama': 'Local Ollama',
  'claude-cli': 'Local `claude` CLI (subscription, text-only)',
};

/** Display label for a model entry — use label if available, else truncated ID. */
function modelLabel(m: ModelEntry): string {
  return m.label ?? (m.id.length > 40 ? m.id.slice(0, 37) + '...' : m.id);
}

// Truncate long error messages (e.g. raw JSON from 401 responses)
function truncateError(msg: string, max = 80): string {
  if (msg.length <= max) return msg;
  return msg.slice(0, max) + '...';
}

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

// ── Credential resolution trace — the "which file did each layer read, and who
//    won?" transparency panel inside the Bedrock card ──

const OWNER_LABELS: Record<string, string> = {
  'walnut': 'Walnut',
  'claude-code': 'Claude Code',
  'shell-env': 'Shell env',
  'aws-cli': 'AWS CLI',
};

function CredentialTracePanel() {
  const [open, setOpen] = useState(false);
  const [trace, setTrace] = useState<CredentialTrace | null>(null);
  const [verify, setVerify] = useState<CredentialVerify | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'verifying' | 'error'>('idle');

  const load = async (withVerify: boolean) => {
    setState(withVerify ? 'verifying' : 'loading');
    try {
      const res = await fetchCredentialTrace(withVerify);
      setTrace(res.trace);
      if (res.verify) setVerify(res.verify);
      setState('idle');
    } catch {
      setState('error');
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !trace) load(false);
  };

  return (
    <div style={{ marginTop: 10 }}>
      <div className="provider-models-toggle" onClick={toggle}>
        <span className="provider-card-arrow">{open ? '▾' : '▸'}</span>
        <span>How was this credential resolved?</span>
      </div>
      {open && (
        <div style={{ marginTop: 6, padding: '8px 10px', border: '1px solid var(--border-color, #e5e5e5)', borderRadius: 8 }}>
          {state === 'loading' && <p className="text-xs text-muted">Tracing resolution…</p>}
          {state === 'error' && <p className="text-xs text-muted">Failed to load the trace.</p>}
          {trace && (
            <>
              <p className="text-xs text-muted" style={{ margin: '0 0 6px' }}>
                Walnut checks these sources top-to-bottom; the first one holding a credential wins.
              </p>
              <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {trace.steps.map((s) => (
                  <li key={s.step} style={{ opacity: s.outcome === 'not-reached' ? 0.45 : 1 }}>
                    <div className="text-sm" style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: s.outcome === 'won' ? 600 : 400 }}>
                        {s.outcome === 'won' ? '✓' : s.outcome === 'empty' ? '✗' : '·'}
                      </span>
                      <span className="provider-badge" style={{ fontSize: 10 }}>{OWNER_LABELS[s.owner] ?? s.owner}</span>
                      <code style={{ fontSize: 11 }}>{s.location}</code>
                      {s.outcome === 'won' && s.found && (
                        <span className="text-xs" style={{ fontWeight: 600 }}>
                          → {s.found.method}{s.found.keyHint ? ` (${s.found.keyHint})` : ''}{s.found.value ? `: ${s.found.value}` : ''}
                        </span>
                      )}
                      {s.outcome === 'empty' && <span className="text-xs text-muted">nothing set</span>}
                      {s.outcome === 'not-reached' && <span className="text-xs text-muted">not checked — a higher source already won</span>}
                    </div>
                    <div className="text-xs text-muted" style={{ marginLeft: 18 }}>
                      looks for: {s.checkedFor.join(' · ')}
                    </div>
                  </li>
                ))}
              </ol>
              <p className="text-xs text-muted" style={{ margin: '8px 0 0' }}>
                Region: <code style={{ fontSize: 11 }}>{trace.region.value}</code> from {trace.region.source}
              </p>

              {/* Live verify — proves the winner actually works (catches expired ~/.aws caches) */}
              <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-sm" onClick={() => load(true)} disabled={state === 'verifying'}>
                  {state === 'verifying' ? 'Verifying…' : 'Verify identity (STS)'}
                </button>
                {verify && verify.status === 'valid' && (
                  <span className="text-xs">
                    ✓ <code style={{ fontSize: 11 }}>{verify.arn}</code>
                    {verify.expiration ? ` · expires ${new Date(verify.expiration).toLocaleTimeString()}` : ''}
                  </span>
                )}
                {verify && verify.status === 'invalid' && (
                  <span className="text-xs" style={{ color: 'var(--danger, #c0392b)' }}>
                    ✗ Credential does NOT work: {truncateError(verify.error ?? 'unknown error', 120)}
                  </span>
                )}
                {verify && verify.status === 'unverifiable' && (
                  <span className="text-xs text-muted">
                    Bearer tokens can't be checked via STS — use Test Connection for a real round-trip.
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Bedrock-specific config inside the active card ──
function BedrockConfig({
  config,
  serverInfo,
  onSave,
  onAfterSave,
  onTest,
  testStatus,
  testMsg,
}: {
  config: Config;
  serverInfo?: ProviderStatus;
  onSave: (partial: Partial<Config>) => Promise<void>;
  onAfterSave?: () => Promise<void>;
  onTest: (params: {
    bedrock_region: string;
    bedrock_bearer_token?: string;
    bedrock_access_key?: string;
    bedrock_secret_key?: string;
    bedrock_profile?: string;
    bedrock_credential_export?: string;
  }) => Promise<void>;
  testStatus: 'idle' | 'testing' | 'ok' | 'error';
  testMsg?: string;
}) {
  const bedrockConf = config.providers?.bedrock;
  const legacyRegion = config.provider?.bedrock_region;
  const legacyToken = config.provider?.bedrock_bearer_token;

  const [region, setRegion] = useState(bedrockConf?.region ?? legacyRegion ?? 'us-west-2');
  const [token, setToken] = useState(bedrockConf?.bearer_token ?? legacyToken ?? '');
  const [accessKey, setAccessKey] = useState(bedrockConf?.aws_access_key_id ?? '');
  const [secretKey, setSecretKey] = useState(bedrockConf?.aws_secret_access_key ?? '');
  const [profile, setProfile] = useState(bedrockConf?.aws_profile ?? '');
  const [credentialExport, setCredentialExport] = useState(bedrockConf?.aws_credential_export ?? '');
  const [profiles, setProfiles] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // Credential source detected by backend
  const cs = serverInfo?.credential_source;
  const keyHint = serverInfo?.key_hint;
  const isReady = serverInfo?.status === 'ready';

  // Determine which method the backend is actually using
  const detectedMethod: 'token' | 'keys' | 'profile' | 'export' | 'auto' =
    cs === 'bearer_token' ? 'token'
    : (cs === 'access_keys' || cs === 'env_api_key' || cs === 'aws_env' || cs === 'aws_credentials_file' || cs === 'api_key') ? 'keys'
    : (cs === 'profile' || cs === 'aws_config_file') ? 'profile'
    : cs === 'credential_process' ? 'export'
    : 'auto';

  // Selected credential tab — defaults to backend-detected method, or 'token' as fallback
  const [selectedMethod, setSelectedMethod] = useState<'token' | 'keys' | 'profile' | 'export'>(
    detectedMethod !== 'auto' ? detectedMethod : 'token'
  );

  useEffect(() => {
    const bc = config.providers?.bedrock;
    setRegion(bc?.region ?? config.provider?.bedrock_region ?? 'us-west-2');
    setToken(bc?.bearer_token ?? config.provider?.bedrock_bearer_token ?? '');
    setAccessKey(bc?.aws_access_key_id ?? '');
    setSecretKey(bc?.aws_secret_access_key ?? '');
    setProfile(bc?.aws_profile ?? '');
    setCredentialExport(bc?.aws_credential_export ?? '');
  }, [config]);

  // Update selected tab when backend detection changes
  useEffect(() => {
    if (detectedMethod !== 'auto') setSelectedMethod(detectedMethod);
  }, [detectedMethod]);

  // Fetch AWS profiles on mount
  useEffect(() => {
    fetchAwsProfiles().then(setProfiles).catch(() => {});
  }, []);

  // Save with a specific method (uses current field values).
  // `overrides` lets <select> onChange handlers save immediately without waiting for
  // the async setState to flush — the handler's closure still holds the OLD value, so
  // saving without an override would persist the stale (often empty) field. That was
  // the "profile snaps back to None" bug: save wrote no aws_profile, the config echo
  // then reset the dropdown.
  const saveWithMethod = async (
    method: 'token' | 'keys' | 'profile' | 'export',
    overrides?: { region?: string; profile?: string },
  ) => {
    const effProfile = overrides?.profile ?? profile;
    const creds: Record<string, string> = {};
    if (method === 'token' && token) creds.bearer_token = token;
    if (method === 'keys' && accessKey) creds.aws_access_key_id = accessKey;
    if (method === 'keys' && secretKey) creds.aws_secret_access_key = secretKey;
    if (method === 'profile' && effProfile) creds.aws_profile = effProfile;
    if (method === 'export' && credentialExport) creds.aws_credential_export = credentialExport;

    // Preserve non-credential fields (models, base_url, …) while REPLACING the
    // credential fields — switching auth method must not leave the old method's
    // secret behind, but must also not wipe the provider's model list.
    const {
      bearer_token: _bt, aws_access_key_id: _ak, aws_secret_access_key: _sk,
      aws_profile: _pf, aws_credential_export: _ce,
      ...rest
    } = config.providers?.bedrock ?? {};

    await onSave({
      providers: {
        ...config.providers,
        bedrock: {
          ...rest,
          api: 'bedrock' as const,
          region: overrides?.region ?? region,
          ...creds,
        },
      },
    });
    await onAfterSave?.();
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveWithMethod(selectedMethod);
    } finally {
      setSaving(false);
    }
  };

  // Check if a method has the required fields filled
  const methodReady = (method: 'token' | 'keys' | 'profile' | 'export'): boolean => {
    if (method === 'token') return !!(token || (cs === 'bearer_token'));  // env token counts
    if (method === 'keys') return !!(accessKey && secretKey);
    if (method === 'profile') return !!(profile || profiles.length > 0);  // profile dropdown has a default
    if (method === 'export') return !!(credentialExport || cs === 'credential_process');
    return false;
  };

  // Radio click: select + auto-save only if fields are ready
  const selectMethod = (method: 'token' | 'keys' | 'profile' | 'export') => {
    if (method === selectedMethod) return;
    setSelectedMethod(method);
    if (methodReady(method)) saveWithMethod(method);
  };

  // Auto-save when fields change (called on blur from inputs)
  const handleFieldBlur = () => {
    if (methodReady(selectedMethod)) saveWithMethod(selectedMethod);
  };

  const handleTest = () => {
    const params: Parameters<typeof onTest>[0] = { bedrock_region: region };
    if (selectedMethod === 'token' && token) params.bedrock_bearer_token = token;
    if (selectedMethod === 'keys' && accessKey && secretKey) {
      params.bedrock_access_key = accessKey;
      params.bedrock_secret_key = secretKey;
    }
    if (selectedMethod === 'profile' && profile) params.bedrock_profile = profile;
    if (selectedMethod === 'export' && credentialExport) params.bedrock_credential_export = credentialExport;
    onTest(params);
  };

  return (
    <div className="provider-active-config">
      {/* Region — applies to all auth methods */}
      <div className="provider-config-row">
        <div className="form-group" style={{ margin: 0, flex: 1, maxWidth: 200 }}>
          <label htmlFor="bedrock-region">Region</label>
          <select id="bedrock-region" value={region} onChange={(e) => { const r = e.target.value; setRegion(r); if (methodReady(selectedMethod)) saveWithMethod(selectedMethod, { region: r }); }}>
            {BEDROCK_REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
      </div>

      {/* Credentials — radio selection */}
      <div className="bedrock-cred-section">
        <div className="bedrock-cred-section-header">Credentials</div>

        {/* Bearer Token */}
        <div className={`bedrock-cred-group${selectedMethod !== 'token' ? ' dimmed' : ''}`}>
          <label className="bedrock-cred-radio" onClick={() => selectMethod('token')}>
            <input type="radio" name="bedrock-auth" checked={selectedMethod === 'token'} onChange={() => selectMethod('token')} />
            <span>Bearer Token</span>
          </label>
          <SecretInput
            id="bedrock-token"
            value={token}
            onChange={setToken}
            onBlur={handleFieldBlur}
            disabled={selectedMethod !== 'token'}
            placeholder={cs === 'bearer_token' && keyHint && !token
              ? `Detected from env (${keyHint})`
              : 'AWS Identity Center bearer token'}
          />
          {selectedMethod === 'token' && cs === 'bearer_token' && !token && (
            <p className="text-xs text-muted" style={{ marginTop: 2 }}>
              Using <code style={{ fontSize: 11 }}>AWS_BEARER_TOKEN_BEDROCK</code> from env. Paste above to override.
            </p>
          )}
        </div>

        {/* Access Keys */}
        <div className={`bedrock-cred-group${selectedMethod !== 'keys' ? ' dimmed' : ''}`}>
          <label className="bedrock-cred-radio" onClick={() => selectMethod('keys')}>
            <input type="radio" name="bedrock-auth" checked={selectedMethod === 'keys'} onChange={() => selectMethod('keys')} />
            <span>Access Keys</span>
          </label>
          <input
            id="bedrock-access-key"
            type="text"
            value={accessKey}
            onChange={(e) => setAccessKey(e.target.value)}
            onBlur={handleFieldBlur}
            disabled={selectedMethod !== 'keys'}
            placeholder="Access Key ID (AKIA...)"
            autoComplete="off"
          />
          <SecretInput
            id="bedrock-secret-key"
            value={secretKey}
            onChange={setSecretKey}
            onBlur={handleFieldBlur}
            disabled={selectedMethod !== 'keys'}
            placeholder="Secret Access Key"
          />
          {selectedMethod === 'keys' && cs === 'aws_env' && !accessKey && (
            <p className="text-xs text-muted" style={{ marginTop: 2 }}>
              Using <code style={{ fontSize: 11 }}>AWS_ACCESS_KEY_ID</code> from env. Enter keys above to override.
            </p>
          )}
          {selectedMethod === 'keys' && cs === 'aws_credentials_file' && !accessKey && (
            <p className="text-xs text-muted" style={{ marginTop: 2 }}>
              Using <code style={{ fontSize: 11 }}>~/.aws/credentials</code>. Enter keys above to override.
            </p>
          )}
        </div>

        {/* AWS Profile */}
        <div className={`bedrock-cred-group${selectedMethod !== 'profile' ? ' dimmed' : ''}`}>
          <label className="bedrock-cred-radio" onClick={() => selectMethod('profile')}>
            <input type="radio" name="bedrock-auth" checked={selectedMethod === 'profile'} onChange={() => selectMethod('profile')} />
            <span>AWS Profile</span>
          </label>
          {profiles.length > 0 ? (
            <select
              id="bedrock-profile"
              value={profile}
              disabled={selectedMethod !== 'profile'}
              onChange={(e) => {
                // Pass the picked value straight to save — the `profile` state var in this
                // closure is stale (setState hasn't flushed), so relying on handleFieldBlur
                // here used to save an EMPTY profile and the dropdown snapped back to None.
                const p = e.target.value;
                setProfile(p);
                saveWithMethod('profile', { profile: p });
              }}
            >
              <option value="">None (auto-detect)</option>
              {profiles.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          ) : (
            <input
              id="bedrock-profile"
              type="text"
              value={profile}
              disabled={selectedMethod !== 'profile'}
              onChange={(e) => setProfile(e.target.value)}
              onBlur={handleFieldBlur}
              placeholder="Profile name from ~/.aws/config"
            />
          )}
          {selectedMethod === 'profile' && (
            <p className="text-xs text-muted" style={{ marginTop: 2 }}>
              {cs === 'aws_config_file' && !profile
                ? <>Using <code style={{ fontSize: 11 }}>~/.aws/config</code>. Select a profile to override.</>
                : 'Supports SSO, credential_process, role chaining.'}
            </p>
          )}
        </div>

        {/* Credential command (awsCredentialExport) — SSO / temporary creds */}
        <div className={`bedrock-cred-group${selectedMethod !== 'export' ? ' dimmed' : ''}`}>
          <label className="bedrock-cred-radio" onClick={() => selectMethod('export')}>
            <input type="radio" name="bedrock-auth" checked={selectedMethod === 'export'} onChange={() => selectMethod('export')} />
            <span>Credential command</span>
          </label>
          <input
            id="bedrock-credential-export"
            type="text"
            value={credentialExport}
            onChange={(e) => setCredentialExport(e.target.value)}
            onBlur={handleFieldBlur}
            disabled={selectedMethod !== 'export'}
            placeholder="e.g. aws configure export-credentials --format process"
            autoComplete="off"
          />
          {selectedMethod === 'export' && (
            <p className="text-xs text-muted" style={{ marginTop: 2 }}>
              {cs === 'credential_process' && !credentialExport
                ? <>Detected from <code style={{ fontSize: 11 }}>~/.claude/settings.json</code> (<code style={{ fontSize: 11 }}>awsCredentialExport</code>). Enter to override.</>
                : 'A command that prints temporary AWS creds as JSON. Auto-refreshed near expiry.'}
            </p>
          )}
        </div>
      </div>

      {/* Step-by-step resolution transparency */}
      <CredentialTracePanel />

      {/* Actions */}
      <div className="provider-config-row" style={{ alignItems: 'center', gap: 8, marginTop: 8 }}>
        <button type="button" className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button" className="btn btn-sm"
          onClick={handleTest}
          disabled={testStatus === 'testing'}
        >
          {testStatus === 'testing' ? 'Testing...' : 'Test Connection'}
        </button>
        {testStatus !== 'idle' && (
          <StatusIndicator
            status={testStatus === 'ok' ? 'connected' : testStatus === 'error' ? 'error' : 'unknown'}
            text={testMsg}
          />
        )}
      </div>
    </div>
  );
}

// ── Model config inside the active provider card ──
function ModelConfig({
  models,
  mainModel,
  maxTokens,
  showModels,
  onMainModelChange,
  onMaxTokensChange,
  onAddModel,
  onRemoveModel,
  onToggleModels,
}: {
  models: ModelEntry[];
  mainModel?: string;           // undefined = non-active provider, hide global controls
  maxTokens?: number | undefined;
  showModels: boolean;
  onMainModelChange: (v: string) => void;
  onMaxTokensChange: (v: number | undefined) => void;
  onAddModel: (id: string) => void;
  onRemoveModel: (id: string) => void;
  onToggleModels: () => void;
}) {
  const [newModelId, setNewModelId] = useState('');

  return (
    <div className="provider-model-config">
      <div className="provider-config-row">
        {models.length > 0 && (
          <div className="form-group" style={{ margin: 0, flex: 1 }}>
            <label htmlFor="main-model">Model</label>
            <select
              id="main-model"
              value={mainModel ?? ''}
              onChange={(e) => onMainModelChange(e.target.value)}
            >
              <option value="">Default</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{modelLabel(m)}</option>
              ))}
            </select>
          </div>
        )}
        <div className="form-group" style={{ margin: 0, flex: 1, maxWidth: 160 }}>
          <label htmlFor="max-tokens">Max Tokens</label>
          <NumberInput
            id="max-tokens"
            value={maxTokens}
            onChange={onMaxTokensChange}
            placeholder="16384"
            min={1}
          />
        </div>
      </div>

      {/* Model list — always visible when card is expanded */}
      <div className="provider-models-toggle" onClick={onToggleModels}>
        <span className="provider-card-arrow">{showModels ? '▾' : '▸'}</span>
        <span>Available Models ({models.length})</span>
      </div>
      {showModels && (
        <div className="provider-models-editor">
          {models.map((m) => (
            <div key={m.id} className="provider-model-chip">
              <span>{m.label ? `${m.label} — ${m.id}` : m.id}</span>
              <button type="button" className="chip-remove" onClick={() => onRemoveModel(m.id)}>×</button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <input
              type="text"
              value={newModelId}
              onChange={(e) => setNewModelId(e.target.value)}
              placeholder="Add model ID..."
              style={{ flex: 1 }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === 'Enter' && newModelId.trim()) {
                  onAddModel(newModelId.trim());
                  setNewModelId('');
                }
              }}
            />
            <button
              type="button"
              className="btn btn-sm"
              disabled={!newModelId.trim()}
              onClick={() => { onAddModel(newModelId.trim()); setNewModelId(''); }}
            >
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Individual provider card ──
function ProviderCard({
  def,
  isActive,
  serverInfo,
  configApiKey,
  config,
  mainModel,
  maxTokens,
  onSelectActive,
  onSave,
  onAfterSave,
  onSaveKey,
  onSaveMainModel,
  onSaveMaxTokens,
  onSaveProviderModels,
}: {
  def: typeof ALL_PROVIDERS[number];
  isActive: boolean;
  serverInfo?: ProviderStatus;
  configApiKey?: string;
  config: Config;
  mainModel: string;
  maxTokens: number | undefined;
  onSelectActive: (name: string) => void;
  onSave: (partial: Partial<Config>) => Promise<void>;
  onAfterSave?: () => Promise<void>;
  onSaveKey: (name: string, key: string) => Promise<void>;
  onSaveMainModel: (v: string) => void;
  onSaveMaxTokens: (v: number | undefined) => void;
  onSaveProviderModels: (providerName: string, models: ModelEntry[]) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(isActive);
  const [apiKey, setApiKey] = useState(configApiKey ?? '');
  const [saving, setSaving] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [testMsg, setTestMsg] = useState<string | undefined>();
  const [showModels, setShowModels] = useState(false);

  // Auto-expand when becoming active
  useEffect(() => { if (isActive) setExpanded(true); }, [isActive]);
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

  const handleBedrockTest = async (params: {
    bedrock_region: string;
    bedrock_bearer_token?: string;
    bedrock_access_key?: string;
    bedrock_secret_key?: string;
    bedrock_profile?: string;
  }) => {
    setTestStatus('testing');
    setTestMsg(undefined);
    try {
      const result = await testConnection(params);
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

  const handleRadioClick = () => {
    if (!isActive) {
      onSelectActive(def.name);
    }
  };

  // Status display — rely on backend status, not frontend needsKey heuristics
  let statusDot: 'connected' | 'error' | 'unknown' = 'unknown';
  let statusLabel = 'Not configured';
  if (testStatus === 'ok') { statusDot = 'connected'; statusLabel = testMsg!; }
  else if (testStatus === 'error') { statusDot = 'error'; statusLabel = testMsg!; }
  else if (testStatus === 'testing') { statusDot = 'unknown'; statusLabel = 'Testing...'; }
  else if (isConfigured) {
    statusDot = 'connected';
    // Show credential source for bedrock
    const cs = serverInfo?.credential_source;
    if (cs === 'access_keys') statusLabel = 'Ready (access keys)';
    else if (cs === 'profile') statusLabel = 'Ready (profile)';
    else if (cs === 'aws_credentials_file') statusLabel = 'Ready (~/.aws/credentials)';
    else if (cs === 'aws_config_file') statusLabel = 'Ready (~/.aws/config)';
    else if (cs === 'aws_env') statusLabel = 'Ready (AWS env vars)';
    else if (cs === 'bearer_token' && isEnv) statusLabel = 'Ready (env)';
    else if (cs === 'subscription') statusLabel = 'Ready (subscription logged in)';
    else if (isEnv) statusLabel = 'Ready (env)';
    else statusLabel = 'Ready';
  }
  else if (def.api === 'ollama') { statusDot = 'error'; statusLabel = 'Offline'; }
  else if (def.api === 'claude-cli') {
    const cs = serverInfo?.credential_source;
    statusDot = 'error';
    statusLabel = cs === 'cli_not_installed' ? 'CLI not installed' : 'Not logged in';
  }

  const envKeyName = `${def.name.toUpperCase().replace(/-/g, '_')}_API_KEY`;

  return (
    <div className={`provider-card${isActive ? ' provider-card-active' : ''}`}>
      <div className="provider-card-header" onClick={() => setExpanded(!expanded)}>
        <div className="provider-card-left">
          {/* Radio button for selecting active provider */}
          <span
            className={`provider-radio${isActive ? ' provider-radio-selected' : ''}`}
            onClick={(e) => { e.stopPropagation(); handleRadioClick(); }}
          />
          <span className="provider-card-label">{def.label}</span>
          {isEnv && <span className="provider-badge auto">env</span>}
          {hasKey && !isEnv && !isActive && <span className="provider-badge configured">key</span>}
        </div>
        <div className="provider-card-right" onClick={(e) => e.stopPropagation()}>
          <StatusIndicator status={statusDot} text={statusLabel} />
          {isConfigured && !isActive && (
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

          {/* Bedrock: region + credentials */}
          {def.api === 'bedrock' && isActive && (
            <BedrockConfig
              config={config}
              serverInfo={serverInfo}
              onSave={onSave}
              onAfterSave={onAfterSave}
              onTest={handleBedrockTest}
              testStatus={testStatus}
              testMsg={testMsg}
            />
          )}

          {/* API Key input for providers that need one */}
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

          {/* Claude Code subscription: text-only, no tool calls — spawns the local `claude` CLI */}
          {def.api === 'claude-cli' && (
            <div>
              {serverInfo?.credential_source === 'cli_not_installed' && (
                <>
                  <p className="text-sm text-muted">
                    Claude Code CLI is not installed. Install it, then log in with{' '}
                    <code style={{ fontSize: 11 }}>claude login</code> to use your subscription.
                  </p>
                  <div style={{ marginTop: 8 }}>
                    <InstallButton target="claude-cli" label="Copy install command" />
                  </div>
                </>
              )}
              {serverInfo?.credential_source === 'cli_no_subscription' && (
                <p className="text-sm text-muted">
                  Claude Code CLI is installed but not logged in. Run{' '}
                  <code style={{ fontSize: 11 }}>claude login</code> in a terminal to sign in with
                  your subscription, then reload this page.
                </p>
              )}
              {serverInfo?.credential_source === 'subscription' && (
                <p className="text-sm text-muted">
                  Detected a logged-in Claude Code subscription (Pro/Max). No API key needed — the
                  butler spawns the local <code style={{ fontSize: 11 }}>claude</code> CLI directly,
                  and its tools work through a structured output protocol.
                </p>
              )}
              <p className="text-sm text-muted" style={{ marginTop: 8, opacity: 0.8 }}>
                Note: this uses your Claude subscription outside the Claude Code app itself.
                Anthropic has previously restricted some subscription usage outside Claude Code —
                use at your own discretion; an API key or Bedrock is the fully supported path.
              </p>
            </div>
          )}

          {/* Non-key providers (bedrock/claude-cli handled above, ollama) */}
          {!def.needsKey && def.api !== 'bedrock' && def.api !== 'claude-cli' && (
            <div>
              <p className="text-sm text-muted">
                No API key required — connects to local server.
              </p>
              {def.api === 'ollama' && statusDot === 'error' && (
                <div style={{ marginTop: 8 }}>
                  <InstallButton target="ollama" label="Copy install command" />
                </div>
              )}
            </div>
          )}

          {/* Model config: active provider shows full config, others show model list only */}
          <ModelConfig
            models={serverInfo?.models ?? []}
            mainModel={isActive ? mainModel : undefined}
            maxTokens={isActive ? maxTokens : undefined}
            showModels={showModels}
            onMainModelChange={onSaveMainModel}
            onMaxTokensChange={onSaveMaxTokens}
            onAddModel={async (id) => {
              const configModels = (config.providers as Record<string, { models?: ModelEntry[] }> | undefined)?.[def.name]?.models ?? [];
              const newEntry: ModelEntry = { id, provider: def.name };
              await onSaveProviderModels(def.name, [...configModels, newEntry]);
            }}
            onRemoveModel={async (id) => {
              const configModels = (config.providers as Record<string, { models?: ModelEntry[] }> | undefined)?.[def.name]?.models ?? [];
              await onSaveProviderModels(def.name, configModels.filter(m => m.id !== id));
            }}
            onToggleModels={() => setShowModels(prev => !prev)}
          />
        </div>
      )}
    </div>
  );
}

export function ProvidersSection({ config, onSave }: Props) {
  const [providers, setProviders] = useState<Record<string, ProviderStatus>>({});
  const [loading, setLoading] = useState(true);
  const activeProvider = config.agent?.main_provider ?? 'bedrock';

  // Global model selection state (lives in config.agent, not per-provider)
  const [mainModel, setMainModel] = useState(config.agent?.main_model ?? '');
  const [maxTokens, setMaxTokens] = useState<number | undefined>(config.agent?.maxTokens);

  useEffect(() => {
    setMainModel(config.agent?.main_model ?? '');
    setMaxTokens(config.agent?.maxTokens);
  }, [config]);

  const loadProviders = useCallback(async () => {
    try {
      const data = await fetchProviders();
      setProviders(data);
    } catch {
      // API not available yet
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

  // Save global agent-level settings (main_model, maxTokens)
  const handleSaveMainModel = async (v: string) => {
    setMainModel(v);
    await onSave({ agent: { ...config.agent, main_model: v || undefined } });
  };
  const handleSaveMaxTokens = async (v: number | undefined) => {
    setMaxTokens(v);
    await onSave({ agent: { ...config.agent, maxTokens: v } });
  };

  // Save per-provider model overrides to config.providers[name].models
  const handleSaveProviderModels = async (providerName: string, models: ModelEntry[]) => {
    const existing = config.providers ?? {};
    const current = existing[providerName] ?? {};
    const template = ALL_PROVIDERS.find(p => p.name === providerName);
    await onSave({
      providers: {
        ...existing,
        [providerName]: {
          ...current,
          api: template?.api ?? current.api ?? 'openai-chat',
          models,
        },
      },
    });
    await loadProviders();
  };

  // The engine flag (config.agent.provider) is a separate axis from these
  // credentials: 'claude-code' routes butler turns into a `claude` CLI session,
  // which brings its own auth — so this whole section stops being what answers
  // chat. Users read "Bedrock selected" as "Bedrock is answering"; say otherwise.
  const laneEngineActive = config.agent?.provider === 'claude-code';

  return (
    <SectionCard
      id="providers"
      title="AI Provider"
      description="Choose your AI provider and model."
      showSave={false}
    >
      {laneEngineActive && (
        <p className="text-sm" style={{
          margin: '0 0 12px',
          padding: '8px 12px',
          borderRadius: 8,
          border: '1px solid color-mix(in srgb, var(--accent) 40%, var(--border))',
          background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
          color: 'var(--fg-secondary)',
        }}>
          Butler chat is currently running on the <strong>Claude Code engine</strong>{' '}
          (<code style={{ fontSize: 11 }}>agent.provider: claude-code</code>) — a
          long-lived <code style={{ fontSize: 11 }}>claude</code> session with its own
          authentication. The provider selected below still powers everything else
          (subagents, summaries, background analysis), just not the main chat replies.
        </p>
      )}
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
              config={config}
              mainModel={mainModel}
              maxTokens={maxTokens}
              onSelectActive={handleSetActive}
              onSave={onSave}
              onAfterSave={loadProviders}
              onSaveKey={handleSaveKey}
              onSaveMainModel={handleSaveMainModel}
              onSaveMaxTokens={handleSaveMaxTokens}
              onSaveProviderModels={handleSaveProviderModels}
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}
