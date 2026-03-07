import { useState, useEffect } from 'react';
import type { Config } from '@walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { SecretInput } from '../inputs/SecretInput';
import { StatusIndicator } from '../inputs/StatusIndicator';
import { testConnection } from '@/api/config';

const BEDROCK_REGIONS = [
  'us-west-2',
  'us-east-1',
  'us-east-2',
  'eu-west-1',
  'eu-west-3',
  'ap-southeast-1',
  'ap-northeast-1',
];

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

export function GettingStartedSection({ config, onSave }: Props) {
  const [region, setRegion] = useState(config.provider?.bedrock_region ?? 'us-west-2');
  const [token, setToken] = useState(config.provider?.bedrock_bearer_token ?? '');
  const [status, setStatus] = useState<'connected' | 'error' | 'unknown' | 'testing'>('unknown');
  const [statusText, setStatusText] = useState<string | undefined>();

  useEffect(() => {
    setRegion(config.provider?.bedrock_region ?? 'us-west-2');
    setToken(config.provider?.bedrock_bearer_token ?? '');
    // If token exists, assume previously configured
    if (config.provider?.bedrock_bearer_token) setStatus('connected');
  }, [config]);

  const handleTest = async () => {
    setStatus('testing');
    setStatusText(undefined);
    try {
      const result = await testConnection({ bedrock_region: region, bedrock_bearer_token: token });
      if (result.ok) {
        setStatus('connected');
        setStatusText(result.latencyMs ? `Connected (${result.latencyMs}ms)` : 'Connected');
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
        bedrock_bearer_token: token,
      },
    });
  };

  const isUnconfigured = !config.provider?.bedrock_bearer_token;

  return (
    <SectionCard
      id="getting-started"
      title="Getting Started"
      description="Configure your AI provider connection. This is required to use Walnut."
      onSave={handleSave}
      attention={isUnconfigured}
      banner={status === 'connected' ? (statusText ?? 'Provider connected') : undefined}
    >
      <div className="form-group">
        <label htmlFor="bedrock-region">Bedrock Region</label>
        <select
          id="bedrock-region"
          value={region}
          onChange={(e) => setRegion(e.target.value)}
        >
          {BEDROCK_REGIONS.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      </div>

      <div className="form-group">
        <label htmlFor="bedrock-token">Bearer Token</label>
        <SecretInput
          id="bedrock-token"
          value={token}
          onChange={setToken}
          placeholder="Paste your bearer token"
        />
      </div>

      <div className="form-row" style={{ alignItems: 'center' }}>
        <button
          type="button"
          className="btn btn-sm"
          onClick={handleTest}
          disabled={!token || status === 'testing'}
        >
          {status === 'testing' ? 'Testing...' : 'Test Connection'}
        </button>
        <StatusIndicator status={status} text={statusText} />
      </div>
    </SectionCard>
  );
}
