import { useState, useEffect } from 'react';
import type { Config } from '@walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { SecretInput } from '../inputs/SecretInput';
import { StatusIndicator } from '../inputs/StatusIndicator';
import { testConnection } from '@/api/config';

const BEDROCK_REGIONS = [
  'us-west-2', 'us-east-1', 'us-east-2',
  'eu-west-1', 'eu-west-3',
  'ap-southeast-1', 'ap-northeast-1',
];

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

export function GettingStartedSection({ config, onSave }: Props) {
  const envHint = (config as Config & { _envTokenHint?: string })._envTokenHint ?? '';
  const [region, setRegion] = useState(config.provider?.bedrock_region ?? 'us-west-2');
  const [token, setToken] = useState(config.provider?.bedrock_bearer_token ?? '');
  const [status, setStatus] = useState<'connected' | 'error' | 'unknown' | 'testing'>('unknown');
  const [statusText, setStatusText] = useState<string | undefined>();

  useEffect(() => {
    setRegion(config.provider?.bedrock_region ?? 'us-west-2');
    setToken(config.provider?.bedrock_bearer_token ?? '');
  }, [config]);

  // Reset connection status when user changes token or region
  useEffect(() => {
    setStatus('unknown');
    setStatusText(undefined);
  }, [token, region]);

  const handleTest = async () => {
    setStatus('testing');
    setStatusText(undefined);
    try {
      const result = await testConnection({ bedrock_region: region, bedrock_bearer_token: token || undefined });
      if (result.ok) {
        setStatus('connected');
        const source = !token && envHint ? ' via environment' : '';
        setStatusText(`Connected${source}${result.latencyMs ? ` (${result.latencyMs}ms)` : ''}`);
      } else {
        setStatus('error');
        setStatusText(result.error ?? 'Connection failed');
      }
    } catch (err) {
      setStatus('error');
      setStatusText((err as Error).message);
    }
  };

  const handleSave = async () => {
    await onSave({
      provider: {
        ...config.provider,
        type: config.provider?.type ?? 'bedrock',
        bedrock_region: region,
        ...(token ? { bedrock_bearer_token: token } : {}),
      },
    });
  };

  // Display value: user-entered token > config token > env hint
  const displayValue = token || envHint;

  return (
    <SectionCard
      id="getting-started"
      title="Getting Started"
      description="Configure your AI provider connection. This is required to use Walnut."
      onSave={handleSave}
    >
      <div className="form-group">
        <label htmlFor="bedrock-region">Bedrock Region</label>
        <select id="bedrock-region" value={region} onChange={(e) => setRegion(e.target.value)}>
          {BEDROCK_REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>

      <div className="form-group">
        <label htmlFor="bedrock-token">Bearer Token</label>
        <SecretInput
          id="bedrock-token"
          value={displayValue}
          onChange={setToken}
          placeholder="Paste your bearer token"
        />
        {!token && envHint && (
          <p className="text-sm text-muted" style={{ marginTop: 4 }}>
            From environment variable. Paste a new token above to override.
          </p>
        )}
      </div>

      <div className="form-row" style={{ alignItems: 'center' }}>
        <button type="button" className="btn btn-sm" onClick={handleTest} disabled={status === 'testing'}>
          {status === 'testing' ? 'Testing...' : 'Test Connection'}
        </button>
        <StatusIndicator status={status} text={statusText} />
      </div>
    </SectionCard>
  );
}
