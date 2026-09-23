import { useState, useEffect, useCallback, type KeyboardEvent, type ReactNode } from 'react';
import type { Config } from '@open-walnut/core';
import { useLocation } from 'react-router-dom';
import {
  SettingsDisclosure, SettingsGroup, SettingsLoadingRow, SettingsRow, SettingsSection, SettingsTag,
} from '../SettingsSection';
import { SecretInput } from '../inputs/SecretInput';
import { NumberInput } from '../inputs/NumberInput';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { SettingsButton } from '../inputs/SettingsButton';
import { InlineConfirmButton } from '../inputs/InlineConfirmButton';
import { useCommitField } from '../inputs/useCommitField';
import { couldntSave } from '../inputs/useOptimisticSetting';
import { saveErrorMessage } from '../settings-pane-context';
import { AlertGlyph, CheckGlyph } from '../settings-glyphs';
import {
  fetchProviders, fetchAwsProfiles, testProvider, testConnection, fetchCredentialTrace,
  type ProviderStatus, type ModelEntry, type CredentialTrace, type CredentialVerify,
} from '@/api/config';
import { InstallButton } from '@/components/common/InstallButton';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { useSerialSave, type OnSave } from './GeneralSection';
import { resolveMainProvider } from './main-provider';

// Providers we actively test and support. `api` matches ProviderConfig.api.
type ProviderApi = 'anthropic-messages' | 'openai-chat' | 'bedrock' | 'google-generative-ai' | 'ollama' | 'claude-cli';
type ProviderDef = { name: string; label: string; api: ProviderApi; base_url?: string; needsKey: boolean };
const ALL_PROVIDERS: ProviderDef[] = [
  // First because it is the default: when `claude` is installed and nothing else is
  // configured, this is what answers (with the CLI's own login, Bedrock or subscription).
  { name: 'claude_cli', label: 'Claude Code', api: 'claude-cli', needsKey: false },
  { name: 'bedrock', label: 'AWS Bedrock', api: 'bedrock', needsKey: false },
  { name: 'anthropic', label: 'Anthropic', api: 'anthropic-messages', needsKey: true },
  { name: 'openai', label: 'OpenAI', api: 'openai-chat', needsKey: true },
  { name: 'openrouter', label: 'OpenRouter', api: 'openai-chat', base_url: 'https://openrouter.ai/api/v1', needsKey: true },
  { name: 'gemini', label: 'Google Gemini', api: 'google-generative-ai', needsKey: true },
  { name: 'ollama', label: 'Ollama (Local)', api: 'ollama', needsKey: false },
];
const CUSTOM_DEFS = ALL_PROVIDERS.filter((p) => p.name !== 'claude_cli');
const PROVIDER_DEFS_BY_NAME = new Map(ALL_PROVIDERS.map((p) => [p.name, p]));

const BEDROCK_REGIONS = [
  'us-west-2', 'us-east-1', 'us-east-2',
  'eu-west-1', 'eu-west-3',
  'ap-southeast-1', 'ap-northeast-1',
];

const OWNER_LABELS: Record<string, string> = {
  'walnut': 'Walnut',
  'claude-code': 'Claude Code',
  'shell-env': 'Shell env',
  'aws-cli': 'AWS CLI',
};

type BedrockMethod = 'token' | 'keys' | 'profile' | 'export';
const METHOD_OPTIONS: { value: BedrockMethod; label: string; testId: string }[] = [
  { value: 'token', label: 'Bearer token', testId: 'bedrock-method-token' },
  { value: 'keys', label: 'Access keys', testId: 'bedrock-method-keys' },
  { value: 'profile', label: 'Profile', testId: 'bedrock-method-profile' },
  { value: 'export', label: 'Command', testId: 'bedrock-method-export' },
];

const LS_LAST_CUSTOM_PROVIDER = 'walnut-custom-agent-provider';

/** Display label for a model entry: its label if any, else the id. */
function modelLabel(m: ModelEntry): string {
  return m.label ?? m.id;
}

// Truncate long error messages (e.g. raw JSON from 401 responses).
function truncateError(msg: string, max = 80): string {
  return msg.length <= max ? msg : msg.slice(0, max) + '...';
}

/** The `Connection` row's result (pure, unit tested). */
export type TestState = { kind: 'idle' | 'testing' } | { kind: 'ok'; ms?: number } | { kind: 'fail'; error: string };
export function testResultText(t: TestState): string | null {
  if (t.kind === 'ok') return t.ms !== undefined ? `Connected in ${t.ms} ms` : 'Connected';
  if (t.kind === 'fail') return `Couldn't connect: ${t.error}`;
  return null;
}

/**
 * Status tag of a provider, from the backend's verdict (pure, unit tested).
 * It names where the credential comes from, so a "Ready" tag above empty key
 * fields says the keys live outside Walnut (N3-26).
 */
export function providerStatusTag(
  def: Pick<ProviderDef, 'api'>,
  info: ProviderStatus | undefined,
  savedKeys = false,
): { text: string; tone: 'success' | 'warning' | 'neutral' } {
  if (info?.status === 'ready') {
    const cs = info.credential_source;
    const via = cs === 'access_keys' ? (savedKeys ? 'the saved access keys' : 'access keys found on this Mac')
      : cs === 'profile' ? 'an AWS profile'
      : cs === 'aws_credentials_file' ? 'the AWS credentials file'
      : cs === 'aws_config_file' ? 'the AWS config file'
      : cs === 'aws_env' || (info.auto_detected && cs !== 'bearer_token') ? 'keys from the environment'
      : cs === 'bearer_token' && info.auto_detected ? 'a token from the environment'
      : null;
    return { text: via ? `Ready, using ${via}` : 'Ready', tone: 'success' };
  }
  if (def.api === 'ollama') return { text: 'Offline', tone: 'warning' };
  return { text: 'Not set up', tone: 'neutral' };
}

/** Bedrock method the backend is actually using ('auto' = none detected). */
function detectedMethodOf(cs: string | undefined): BedrockMethod | 'auto' {
  if (cs === 'bearer_token') return 'token';
  if (cs === 'access_keys' || cs === 'env_api_key' || cs === 'aws_env' || cs === 'aws_credentials_file' || cs === 'api_key') return 'keys';
  if (cs === 'profile' || cs === 'aws_config_file') return 'profile';
  if (cs === 'credential_process') return 'export';
  return 'auto';
}

function TestResult({ state }: { state: TestState }) {
  const text = testResultText(state);
  if (!text) return null;
  return (
    <span className="settings-test-result" data-kind={state.kind} role={state.kind === 'fail' ? 'alert' : undefined} data-testid="provider-test-result">
      {state.kind === 'ok' ? <CheckGlyph size={12} /> : <AlertGlyph size={12} />}
      {text}
    </span>
  );
}

/** "Which file did each layer read, and who won?" as indent rows under Bedrock. */
function CredentialTraceRows() {
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

  const verifyText = !verify ? null
    : verify.status === 'valid' ? `Works as ${verify.arn ?? 'unknown'}${verify.expiration ? `, expires ${new Date(verify.expiration).toLocaleTimeString()}` : ''}.`
    : verify.status === 'invalid' ? `Doesn't work: ${truncateError(verify.error ?? 'unknown error', 120)}`
    : verify.status === 'unverifiable' ? "Bearer tokens can't be checked this way; use Test connection instead."
    : null;

  return (
    <>
      <SettingsRow
        indent
        label="Where the keys come from"
        help={state === 'error' ? "Couldn't check the sources." : 'Sources are checked top to bottom; the first one holding a credential wins.'}
        state={state === 'error' ? 'warning' : undefined}
        control={
          <SettingsButton busy={state === 'loading'} busyLabel="Checking..." onClick={() => void load(false)} data-testid="bedrock-trace">
            {trace ? 'Check again' : 'Check where keys come from'}
          </SettingsButton>
        }
      />
      {trace?.steps.map((s) => (
        <SettingsRow
          key={s.step}
          indent
          disabled={s.outcome === 'not-reached'}
          label={<code className="settings-mono-value">{s.location}</code>}
          help={s.outcome === 'won' && s.found
            ? `Used: ${s.found.method}${s.found.keyHint ? ` (${s.found.keyHint})` : ''}${s.found.value ? `, ${s.found.value}` : ''}`
            : s.outcome === 'empty' ? `Nothing set; looks for ${s.checkedFor.join(', ')}.`
            : 'Not checked; a higher source already won.'}
          control={
            <span className="settings-control-cluster">
              <SettingsTag>{OWNER_LABELS[s.owner] ?? s.owner}</SettingsTag>
              {s.outcome === 'won' && <SettingsTag tone="success">Used</SettingsTag>}
            </span>
          }
        />
      ))}
      {trace && (
        <SettingsRow
          indent
          label="Identity"
          help={verifyText ?? <>Region <code>{trace.region.value}</code> from {trace.region.source}.</>}
          state={verify?.status === 'invalid' ? 'warning' : undefined}
          control={
            <SettingsButton busy={state === 'verifying'} busyLabel="Verifying..." onClick={() => void load(true)}>
              Verify identity
            </SettingsButton>
          }
        />
      )}
    </>
  );
}

/** Bedrock: region, credential method and its fields, as indent rows. */
function BedrockRows({ config, serverInfo, onSave, onAfterSave, onTest, testState }: {
  testState: TestState;
  config: Config;
  serverInfo?: ProviderStatus;
  onSave: OnSave;
  onAfterSave: () => Promise<void>;
  onTest: (params: Parameters<typeof testConnection>[0]) => void;
}) {
  const bedrockConf = config.providers?.bedrock;
  const [region, setRegion] = useState(bedrockConf?.region ?? config.provider?.bedrock_region ?? 'us-west-2');
  const [token, setToken] = useState(bedrockConf?.bearer_token ?? config.provider?.bedrock_bearer_token ?? '');
  const [accessKey, setAccessKey] = useState(bedrockConf?.aws_access_key_id ?? '');
  const [secretKey, setSecretKey] = useState(bedrockConf?.aws_secret_access_key ?? '');
  const [profile, setProfile] = useState(bedrockConf?.aws_profile ?? '');
  const [credentialExport, setCredentialExport] = useState(bedrockConf?.aws_credential_export ?? '');
  const [profiles, setProfiles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const cs = serverInfo?.credential_source;
  const detected = detectedMethodOf(cs);
  const [method, setMethod] = useState<BedrockMethod>(detected !== 'auto' ? detected : 'token');

  useEffect(() => {
    const bc = config.providers?.bedrock;
    setRegion(bc?.region ?? config.provider?.bedrock_region ?? 'us-west-2');
    setToken(bc?.bearer_token ?? config.provider?.bedrock_bearer_token ?? '');
    setAccessKey(bc?.aws_access_key_id ?? '');
    setSecretKey(bc?.aws_secret_access_key ?? '');
    setProfile(bc?.aws_profile ?? '');
    setCredentialExport(bc?.aws_credential_export ?? '');
  }, [config]);
  useEffect(() => { if (detected !== 'auto') setMethod(detected); }, [detected]);
  useEffect(() => { fetchAwsProfiles().then(setProfiles).catch(() => {}); }, []);

  // `overrides` carries a just-picked select value: the closure's state is stale
  // until the next render (the old "profile snaps back to None" bug).
  const saveWith = async (m: BedrockMethod, overrides?: { region?: string; profile?: string }) => {
    const effProfile = overrides?.profile ?? profile;
    const creds: Record<string, string> = {};
    if (m === 'token' && token) creds.bearer_token = token;
    if (m === 'keys' && accessKey) creds.aws_access_key_id = accessKey;
    if (m === 'keys' && secretKey) creds.aws_secret_access_key = secretKey;
    if (m === 'profile' && effProfile) creds.aws_profile = effProfile;
    if (m === 'export' && credentialExport) creds.aws_credential_export = credentialExport;
    // Keep models/base_url; REPLACE the credential fields so the old method's
    // secret is not left behind.
    const {
      bearer_token: _bt, aws_access_key_id: _ak, aws_secret_access_key: _sk,
      aws_profile: _pf, aws_credential_export: _ce, ...rest
    } = config.providers?.bedrock ?? {};
    setError(null);
    try {
      await onSave({
        providers: { ...config.providers, bedrock: { ...rest, api: 'bedrock' as const, region: overrides?.region ?? region, ...creds } },
      }, { rowKey: 'providers.bedrock' });
      await onAfterSave();
    } catch (err) {
      setError(couldntSave(saveErrorMessage(err)));
    }
  };
  // A region pick keeps whatever credentials are saved: it must also land when
  // they come from the environment or ~/.aws, where none are in config.
  const saveRegion = async (r: string) => {
    setError(null);
    try {
      await onSave({
        providers: { ...config.providers, bedrock: { ...config.providers?.bedrock, api: 'bedrock' as const, region: r } },
      }, { rowKey: 'providers.bedrock' });
      await onAfterSave();
    } catch (err) {
      setError(couldntSave(saveErrorMessage(err)));
    }
  };
  const ready = (m: BedrockMethod): boolean => {
    if (m === 'token') return !!(token || cs === 'bearer_token');
    if (m === 'keys') return !!(accessKey && secretKey);
    if (m === 'profile') return !!(profile || profiles.length > 0);
    return !!(credentialExport || cs === 'credential_process');
  };
  const commit = () => { if (ready(method)) void saveWith(method); };
  const onEnter = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } };

  const test = () => {
    const params: Parameters<typeof testConnection>[0] = { bedrock_region: region };
    if (method === 'token' && token) params.bedrock_bearer_token = token;
    if (method === 'keys' && accessKey && secretKey) { params.bedrock_access_key = accessKey; params.bedrock_secret_key = secretKey; }
    if (method === 'profile' && profile) params.bedrock_profile = profile;
    if (method === 'export' && credentialExport) params.bedrock_credential_export = credentialExport;
    onTest(params);
  };

  const envHelp: ReactNode = method === 'token' && cs === 'bearer_token' && !token
    ? <>Using <code>AWS_BEARER_TOKEN_BEDROCK</code> from the environment; paste a token to override.</>
    : method === 'keys' && cs === 'aws_env' && !accessKey
      ? <>Using <code>AWS_ACCESS_KEY_ID</code> from the environment; enter keys to override.</>
      : method === 'keys' && cs === 'aws_credentials_file' && !accessKey
        ? <>Using <code>~/.aws/credentials</code>; enter keys to override.</>
        : method === 'profile' && cs === 'aws_config_file' && !profile
          ? <>Using <code>~/.aws/config</code>; pick a profile to override.</>
          : method === 'export' && cs === 'credential_process' && !credentialExport
            ? <>Detected from <code>~/.claude/settings.json</code>; enter a command to override.</>
            : null;

  return (
    <>
      <SettingsRow indent label="Region" htmlFor="bedrock-region" control={
        <select id="bedrock-region" className="settings-select" value={region}
          onChange={(e) => { const r = e.target.value; setRegion(r); void saveRegion(r); }}>
          {BEDROCK_REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      } />
      <SettingsRow indent label="Credentials" error={error} data-testid="bedrock-method-row" control={
        <SegmentedControl<BedrockMethod> aria-label="Credentials" value={method} options={METHOD_OPTIONS}
          onChange={setMethod} />
      } />
      {method === 'token' && (
        <SettingsRow indent label="Bearer token" htmlFor="bedrock-token" help={envHelp} control={
          <SecretInput id="bedrock-token" value={token} onChange={setToken} onBlur={commit}
            placeholder={cs === 'bearer_token' && serverInfo?.key_hint && !token ? `From the environment (${serverInfo.key_hint})` : 'Identity Center bearer token'} />
        } />
      )}
      {method === 'keys' && (
        <>
          <SettingsRow indent label="Access key ID" htmlFor="bedrock-access-key" help={envHelp} control={
            <input id="bedrock-access-key" type="text" className="settings-input settings-input--short settings-input--mono" value={accessKey}
              onChange={(e) => setAccessKey(e.target.value)} onBlur={commit} onKeyDown={onEnter} placeholder="AKIA..." autoComplete="off" />
          } />
          <SettingsRow indent label="Secret access key" htmlFor="bedrock-secret-key" control={
            <SecretInput id="bedrock-secret-key" value={secretKey} onChange={setSecretKey} onBlur={commit} placeholder="Secret access key" />
          } />
        </>
      )}
      {method === 'profile' && (
        <SettingsRow indent label="Profile" htmlFor="bedrock-profile" help={envHelp ?? 'Supports SSO, credential_process and role chaining.'} control={
          profiles.length > 0 ? (
            <select id="bedrock-profile" className="settings-select" value={profile}
              onChange={(e) => { const p = e.target.value; setProfile(p); void saveWith('profile', { profile: p }); }}>
              <option value="">None (auto-detect)</option>
              {profiles.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          ) : (
            <input id="bedrock-profile" type="text" className="settings-input settings-input--short" value={profile}
              onChange={(e) => setProfile(e.target.value)} onBlur={commit} onKeyDown={onEnter} placeholder="Profile name" />
          )
        } />
      )}
      {method === 'export' && (
        <SettingsRow indent wide label="Credential command" htmlFor="bedrock-credential-export"
          help={envHelp ?? 'Prints temporary AWS credentials as JSON; refreshed near expiry.'} control={
          <input id="bedrock-credential-export" type="text" className="settings-input settings-input--long settings-input--mono"
            value={credentialExport} onChange={(e) => setCredentialExport(e.target.value)} onBlur={commit} onKeyDown={onEnter}
            placeholder="aws configure export-credentials --format process" autoComplete="off" spellCheck={false} />
        } />
      )}
      <CredentialTraceRows />
      <SettingsRow indent label="Connection" help={<TestResult state={testState} />} control={
        <SettingsButton busy={testState.kind === 'testing'} busyLabel="Testing..." onClick={test} data-testid="provider-test">
          Test connection
        </SettingsButton>
      } />
    </>
  );
}

/** API model, Max tokens and the provider's model list, as indent rows. */
function ModelRows({ providerName, models, config, onSave, onAfterSave }: {
  providerName: string;
  models: ModelEntry[];
  config: Config;
  onSave: OnSave;
  onAfterSave: () => Promise<void>;
}) {
  const [newModelId, setNewModelId] = useState('');
  const [listError, setListError] = useState<string | null>(null);
  const save = useSerialSave(config, onSave);
  const saveAgent = (patch: Record<string, unknown>, rowKey: string) =>
    save((c) => ({ agent: { ...c.agent, ...patch } as Config['agent'] }), { rowKey });
  const model = useCommitField<string>(
    config.agent?.main_model ?? '',
    (v) => saveAgent({ main_model: v.trim() || undefined }, 'providers.main-model'),
    { rowKey: 'providers.main-model', kind: 'text' },
  );
  const maxTokens = useCommitField<number | undefined>(
    config.agent?.maxTokens,
    (v) => saveAgent({ maxTokens: v }, 'providers.max-tokens'),
    { rowKey: 'providers.max-tokens', kind: 'number' },
  );
  const [pickError, setPickError] = useState<string | null>(null);
  const pickModel = async (v: string) => {
    setPickError(null);
    try { await saveAgent({ main_model: v || undefined }, 'providers.main-model'); }
    catch (err) { setPickError(couldntSave(saveErrorMessage(err))); }
  };
  const configModels = (config.providers as Record<string, { models?: ModelEntry[]; api?: string }> | undefined)?.[providerName];
  const saveModels = async (next: ModelEntry[]) => {
    const template = ALL_PROVIDERS.find((p) => p.name === providerName);
    setListError(null);
    try {
      await onSave({
        providers: {
          ...config.providers,
          [providerName]: { ...configModels, api: template?.api ?? configModels?.api ?? 'openai-chat', models: next },
        } as Config['providers'],
      }, { rowKey: 'providers.models' });
      await onAfterSave();
    } catch (err) {
      setListError(couldntSave(saveErrorMessage(err)));
    }
  };
  const add = () => {
    const id = newModelId.trim();
    if (!id) return;
    setNewModelId('');
    void saveModels([...(configModels?.models ?? []), { id, provider: providerName }]);
  };

  return (
    <>
      {models.length > 0 ? (
        <SettingsRow indent label="API model" htmlFor="main-model" error={pickError} control={
          <select id="main-model" className="settings-select" value={config.agent?.main_model ?? ''} onChange={(e) => void pickModel(e.target.value)}>
            <option value="">Default</option>
            {models.map((m) => <option key={m.id} value={m.id}>{modelLabel(m)}</option>)}
          </select>
        } />
      ) : (
        <SettingsRow indent wide label="API model" htmlFor="main-model" help="Empty uses the provider's default." error={model.error} control={
          <input id="main-model" type="text" className="settings-input settings-input--long settings-input--mono" spellCheck={false}
            placeholder="Default" {...model.inputProps} />
        } />
      )}
      <SettingsRow indent label="Max tokens" htmlFor="max-tokens" error={maxTokens.error} control={
        <NumberInput id="max-tokens" field={maxTokens.inputProps} placeholder="16384" min={1} />
      } />
      <SettingsDisclosure id="providers-models" label="Available models" summary={String(models.length)} data-testid="provider-models-toggle">
        {models.map((m) => (
          <SettingsRow key={m.id} indent label={<code className="settings-mono-value" title={m.id}>{m.id}</code>} help={m.label}
            control={<InlineConfirmButton aria-label={`Remove ${m.id}`} onConfirm={() => saveModels((configModels?.models ?? []).filter((x) => x.id !== m.id))} />} />
        ))}
        <SettingsRow indent wide label="Add a model" htmlFor="provider-add-model" error={listError} control={
          <span className="settings-control-cluster">
            <input id="provider-add-model" type="text" className="settings-input settings-input--long settings-input--mono" value={newModelId}
              placeholder="Model id" spellCheck={false} onChange={(e) => setNewModelId(e.target.value)}
              onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
            <SettingsButton disabled={!newModelId.trim()} title={newModelId.trim() ? undefined : 'Type a model id first.'} onClick={add}>Add</SettingsButton>
          </span>
        } />
      </SettingsDisclosure>
    </>
  );
}

/** The rows under `Provider` for the provider in use. */
function ActiveProviderRows({ def, serverInfo, config, onSave, onAfterSave }: {
  def: ProviderDef;
  serverInfo?: ProviderStatus;
  config: Config;
  onSave: OnSave;
  onAfterSave: () => Promise<void>;
}) {
  const configApiKey = (config.providers as Record<string, { api_key?: string }> | undefined)?.[def.name]?.api_key;
  const [apiKey, setApiKey] = useState(configApiKey ?? '');
  const [saving, setSaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [testState, setTestState] = useState<TestState>({ kind: 'idle' });
  useEffect(() => { setApiKey(configApiKey ?? ''); }, [configApiKey]);
  const isEnv = !!(serverInfo?.auto_detected && serverInfo?.status === 'ready');
  const envKeyName = `${def.name.toUpperCase().replace(/-/g, '_')}_API_KEY`;

  const runTest = async (fn: () => Promise<{ ok: boolean; latencyMs?: number; error?: string }>) => {
    setTestState({ kind: 'testing' });
    try {
      const r = await fn();
      setTestState(r.ok ? { kind: 'ok', ms: r.latencyMs } : { kind: 'fail', error: truncateError(r.error ?? 'Connection failed') });
    } catch (err) {
      setTestState({ kind: 'fail', error: truncateError((err as Error).message) });
    }
  };

  const saveKey = async () => {
    const existing = config.providers ?? {};
    const current = (existing as Record<string, object>)[def.name] ?? {};
    const key = apiKey.trim();
    setSaving(true);
    setKeyError(null);
    try {
      await onSave({
        providers: {
          ...existing,
          [def.name]: { ...current, api: def.api, ...(def.base_url ? { base_url: def.base_url } : {}), ...(key ? { api_key: key } : {}) },
        } as Config['providers'],
      }, { rowKey: `providers.key.${def.name}` });
      await onAfterSave();
    } catch (err) {
      setKeyError(couldntSave(saveErrorMessage(err)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {def.api === 'bedrock' && (
        <BedrockRows config={config} serverInfo={serverInfo} onSave={onSave} onAfterSave={onAfterSave} testState={testState}
          onTest={(params) => void runTest(() => testConnection(params))} />
      )}
      {def.needsKey && (
        <SettingsRow indent label="API key" htmlFor={`key-${def.name}`} error={keyError}
          help={isEnv && !configApiKey ? <>Found in <code>{envKeyName}</code>; paste a key to override it.</> : undefined}
          control={
            <span className="settings-control-cluster">
              <SecretInput id={`key-${def.name}`} value={apiKey} onChange={setApiKey}
                placeholder={isEnv ? `Set by ${envKeyName}` : `Paste ${envKeyName}`} />
              <SettingsButton variant="primary" busy={saving} busyLabel="Saving..." disabled={!apiKey.trim()} title={apiKey.trim() ? undefined : 'Paste a key first.'} onClick={() => void saveKey()}>
                Save key
              </SettingsButton>
            </span>
          } />
      )}
      {def.api === 'ollama' && (
        <SettingsRow indent label="Local server" help="No API key needed; Walnut connects to Ollama on this machine."
          control={serverInfo?.status !== 'ready' ? <InstallButton target="ollama" label="Copy install command" /> : undefined} />
      )}
      <ModelRows providerName={def.name} models={serverInfo?.models ?? []} config={config} onSave={onSave} onAfterSave={onAfterSave} />
      {def.api !== 'bedrock' && (
        <SettingsRow indent label="Connection" help={<TestResult state={testState} />} control={
          <SettingsButton busy={testState.kind === 'testing'} busyLabel="Testing..." onClick={() => void runTest(() => testProvider(def.name))} data-testid="provider-test">
            Test connection
          </SettingsButton>
        } />
      )}
    </>
  );
}

interface Props {
  config: Config;
  onSave: OnSave;
}

/** The human name for a provider id; an id this build does not know never shows raw. */
export function providerDisplayName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  return PROVIDER_DEFS_BY_NAME.get(name)?.label ?? 'an unknown provider';
}

/** Disclosure summary for the API provider row (pure, unit tested). */
export function providersSummary(mode: 'claude' | 'custom' | undefined, label: string | undefined): string {
  if (mode === 'custom') return `On, ${label ?? 'an API'}`;
  if (mode === 'claude') return 'Off';
  return '';
}

export function ProvidersSection({ config, onSave }: Props) {
  const location = useLocation();
  const [providers, setProviders] = useState<Record<string, ProviderStatus>>({});
  const [loading, setLoading] = useState(true);
  const [modeError, setModeError] = useState<string | null>(null);
  // The server applies the default rule (claude_cli when Claude Code is
  // installed, else bedrock); mirror its answer instead of guessing here.
  const { health } = useSystemHealth();
  const save = useSerialSave(config, onSave);
  const serverProvider = config.agent?.main_provider ?? health.mainProvider;
  // Optimistic pick, cleared when config catches up or the write fails.
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => { setPicked(null); }, [serverProvider]);
  const activeProvider = picked ?? serverProvider;

  const loadProviders = useCallback(async () => {
    try {
      setProviders(await fetchProviders());
    } catch {
      // API not available yet
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void loadProviders(); }, [loadProviders]);

  // One choice, one meaning: which provider Walnut calls for the model work it
  // does itself (titles, summaries, memory upkeep). Not an engine pick.
  const setActive = async (name: string) => {
    setPicked(name);
    setModeError(null);
    try {
      await save((c) => ({ agent: { ...c.agent, main_provider: name } as Config['agent'] }), { rowKey: 'providers.mode' });
    } catch (err) {
      setPicked(null);
      setModeError(couldntSave(saveErrorMessage(err)));
    }
  };

  // A user-named entry runs on its `api` (N01): a claude-cli entry is Claude Code.
  const info = resolveMainProvider(activeProvider, config.providers);
  const mode: 'claude' | 'custom' | undefined =
    activeProvider === undefined ? undefined : info.kind === 'cli' ? 'claude' : 'custom';
  const activeDef = CUSTOM_DEFS.find((p) => p.name === activeProvider);
  // Re-picking "An API" returns to the provider it last ran on.
  const pickMode = (next: 'claude' | 'custom') => {
    if (next === mode) return;
    if (next === 'claude') { void setActive('claude_cli'); return; }
    let last: string | null = null;
    try { last = localStorage.getItem(LS_LAST_CUSTOM_PROVIDER); } catch { /* ignore */ }
    void setActive(CUSTOM_DEFS.some((p) => p.name === last) ? last! : 'bedrock');
  };
  const pickProvider = (name: string) => {
    try { localStorage.setItem(LS_LAST_CUSTOM_PROVIDER, name); } catch { /* ignore */ }
    void setActive(name);
  };
  const claudeInfo = providers.claude_cli;
  const claudeHelp: ReactNode = claudeInfo?.credential_source === 'cli_not_installed'
    ? <>Claude Code isn&apos;t installed; install it and run <code>claude</code> once to sign in.</>
    : claudeInfo?.credential_detail
      ? <>Claude Code signs in with {claudeInfo.credential_detail}.</>
      : 'Claude Code uses the login its own CLI already has.';
  const savedKeys = Boolean(config.providers?.bedrock?.aws_access_key_id);
  const tag = activeDef ? providerStatusTag(activeDef, providers[activeDef.name], savedKeys) : null;

  return (
    <SettingsSection
      id="providers"
      title="Use an API instead of Claude Code"
      description={<>Optional: run Walnut&apos;s small background jobs on an API key instead of <span className="settings-nowrap">Claude Code</span>.</>}
    >
      <SettingsGroup data-testid="providers-group">
        <SettingsDisclosure
          id="providers-api"
          data-testid="providers-expand"
          label="API provider"
          summary={<span data-testid="providers-summary">{providersSummary(mode, info.kind === 'unknown' ? providerDisplayName(activeProvider) : info.label)}</span>}
          forceOpen={mode === 'custom' || location.hash === '#providers'}
        >
          <div className="settings-rows-contents" data-testid="provider-modes">
            {loading ? <SettingsLoadingRow /> : (
              <>
                <SettingsRow indent label="Background jobs run on" error={modeError}
                  help={mode === 'claude' ? claudeHelp : 'Task titles, notes and memory upkeep use the provider below.'}
                  control={
                    <SegmentedControl<'claude' | 'custom'> aria-label="Background jobs run on" value={mode ?? 'claude'}
                      onChange={pickMode}
                      options={[
                        { value: 'claude', label: 'Claude Code', testId: 'provider-mode-claude' },
                        { value: 'custom', label: 'An API', testId: 'provider-mode-custom' },
                      ]} />
                  } />
                {mode === 'claude' && claudeInfo?.credential_source === 'cli_not_installed' && (
                  <SettingsRow indent label="Install Claude Code" control={<InstallButton target="claude-cli" label="Copy install command" />} />
                )}
                {mode === 'custom' && !activeDef && info.kind === 'api' && activeProvider && (
                  // A named entry of a known API, set up in config.yaml: name the API,
                  // keep the entry selectable, and never call it unknown (N01).
                  <div className="settings-rows-contents" data-testid="custom-agent-providers">
                    <SettingsRow indent label="Provider" htmlFor="provider-select"
                      help={<>Set up in config.yaml as <code>{activeProvider}</code>.</>} control={
                      <select id="provider-select" data-testid="provider-select" className="settings-select" value={activeProvider}
                        onChange={(e) => { if (e.target.value !== activeProvider) pickProvider(e.target.value); }}>
                        <option value={activeProvider}>{info.label} (config.yaml)</option>
                        {CUSTOM_DEFS.map((p) => <option key={p.name} value={p.name}>{p.label}</option>)}
                      </select>
                    } />
                  </div>
                )}
                {mode === 'custom' && !activeDef && info.kind === 'unknown' && (
                  // A provider name this build does not know (hand-edited config, a newer
                  // build): the Provider row still shows so the user can pick a real one.
                  <div className="settings-rows-contents" data-testid="custom-agent-providers">
                    <SettingsRow indent label="Provider" htmlFor="provider-select" state="warning"
                      help="Walnut doesn't know this provider. Pick one to use." control={
                      <span className="settings-control-cluster">
                        <SettingsTag tone="warning">Unknown provider</SettingsTag>
                        <select id="provider-select" data-testid="provider-select" className="settings-select" value=""
                          onChange={(e) => { if (e.target.value) pickProvider(e.target.value); }}>
                          <option value="" disabled>Choose a provider</option>
                          {CUSTOM_DEFS.map((p) => <option key={p.name} value={p.name}>{p.label}</option>)}
                        </select>
                      </span>
                    } />
                  </div>
                )}
                {mode === 'custom' && activeDef && (
                  <div className="settings-rows-contents" data-testid="custom-agent-providers">
                    <SettingsRow indent label="Provider" htmlFor="provider-select" control={
                      <span className="settings-control-cluster">
                        {tag && <SettingsTag tone={tag.tone}>{tag.text}</SettingsTag>}
                        <select id="provider-select" data-testid="provider-select" className="settings-select" value={activeDef.name}
                          onChange={(e) => pickProvider(e.target.value)}>
                          {CUSTOM_DEFS.map((p) => <option key={p.name} value={p.name}>{p.label}</option>)}
                        </select>
                      </span>
                    } />
                    <ActiveProviderRows key={activeDef.name} def={activeDef} serverInfo={providers[activeDef.name]}
                      config={config} onSave={onSave} onAfterSave={loadProviders} />
                  </div>
                )}
              </>
            )}
          </div>
        </SettingsDisclosure>
      </SettingsGroup>
    </SettingsSection>
  );
}
