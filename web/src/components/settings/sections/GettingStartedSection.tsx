import { useState, useEffect, useRef } from 'react';
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
  const [region, setRegion] = useState(config.provider?.bedrock_region ?? 'us-west-2');
  const [token, setToken] = useState(config.provider?.bedrock_bearer_token ?? '');
  const [status, setStatus] = useState<'connected' | 'error' | 'unknown' | 'testing'>('testing');
  const [statusText, setStatusText] = useState<string | undefined>('Checking connection...');
  const [envDetected, setEnvDetected] = useState(false);
  const autoTestedRef = useRef(false);

  useEffect(() => {
    setRegion(config.provider?.bedrock_region ?? 'us-west-2');
    setToken(config.provider?.bedrock_bearer_token ?? '');
  }, [config]);

  // Auto-test connection on first mount (catches env var auth)
  useEffect(() => {
    if (autoTestedRef.current) return;
    autoTestedRef.current = true;
    testConnection({ bedrock_region: region })
      .then((result) => {
        if (result.ok) {
          setStatus('connected');
          const viaEnv = !token;
          if (viaEnv) setEnvDetected(true);
          setStatusText(`Connected${viaEnv ? ' via environment' : ''}${result.latencyMs ? ` (${result.latencyMs}ms)` : ''}`);
        } else {
          setStatus('unknown');
          setStatusText(undefined);
        }
      })
      .catch(() => { setStatus('unknown'); setStatusText(undefined); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTest = async () => {
    setStatus('testing');
    setStatusText(undefined);
    try {
      const result = await testConnection({ bedrock_region: region, bedrock_bearer_token: token || undefined });
      if (result.ok) {
        setStatus('connected');
        const source = !token ? ' (via environment)' : '';
        setStatusText(`Connected${source}${result.latencyMs ? ` — ${result.latencyMs}ms` : ''}`);
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
        {envDetected && !token ? (
          <>
            <div style={{
              padding: '8px 12px', borderRadius: 6, fontSize: 13,
              background: 'rgba(52, 199, 89, 0.08)', border: '1px solid rgba(52, 199, 89, 0.3)',
              color: 'var(--success)', display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ fontSize: 16 }}>&#x2713;</span>
              <span>Configured via <code style={{ fontSize: 12 }}>AWS_BEARER_TOKEN_BEDROCK</code> environment variable</span>
            </div>
            <p className="text-sm text-muted" style={{ marginTop: 4, cursor: 'pointer' }}
              onClick={() => setEnvDetected(false)}>
              Want to override? Click here to enter a token manually.
            </p>
          </>
        ) : (
          <SecretInput id="bedrock-token" value={token} onChange={setToken} placeholder="Paste your bearer token" />
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
