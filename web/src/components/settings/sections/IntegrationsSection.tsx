import { useState, useEffect } from 'react';
import type { Config } from '@walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { SecretInput } from '../inputs/SecretInput';

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

export function IntegrationsSection({ config, onSave }: Props) {
  // MS-Todo
  const msTodo = (config.plugins?.['ms-todo'] ?? {}) as Record<string, unknown>;
  const [msTodoEnabled, setMsTodoEnabled] = useState(!!msTodo.enabled);
  const [msTodoClientId, setMsTodoClientId] = useState((msTodo.client_id as string) ?? '');

  // Slack
  const [slackToken, setSlackToken] = useState(config.tools?.slack?.bot_token ?? '');
  const [slackChannel, setSlackChannel] = useState(config.tools?.slack?.default_channel ?? '');

  // Web Search
  const [searchProvider, setSearchProvider] = useState(config.tools?.web_search?.provider ?? '');
  const [searchApiKey, setSearchApiKey] = useState(config.tools?.web_search?.api_key ?? '');
  const [perplexityKey, setPerplexityKey] = useState(config.tools?.web_search?.perplexity_api_key ?? '');

  // TTS
  const [ttsProvider, setTtsProvider] = useState(config.tools?.tts?.provider ?? '');
  const [ttsVoice, setTtsVoice] = useState(config.tools?.tts?.voice ?? '');

  useEffect(() => {
    const ms = (config.plugins?.['ms-todo'] ?? {}) as Record<string, unknown>;
    setMsTodoEnabled(!!ms.enabled);
    setMsTodoClientId((ms.client_id as string) ?? '');
    setSlackToken(config.tools?.slack?.bot_token ?? '');
    setSlackChannel(config.tools?.slack?.default_channel ?? '');
    setSearchProvider(config.tools?.web_search?.provider ?? '');
    setSearchApiKey(config.tools?.web_search?.api_key ?? '');
    setPerplexityKey(config.tools?.web_search?.perplexity_api_key ?? '');
    setTtsProvider(config.tools?.tts?.provider ?? '');
    setTtsVoice(config.tools?.tts?.voice ?? '');
  }, [config]);

  const handleSave = async () => {
    await onSave({
      plugins: {
        ...config.plugins,
        'ms-todo': {
          ...(config.plugins?.['ms-todo'] ?? {}),
          enabled: msTodoEnabled,
          client_id: msTodoClientId || undefined,
        },
      },
      tools: {
        ...config.tools,
        slack: {
          ...config.tools?.slack,
          bot_token: slackToken || undefined,
          default_channel: slackChannel || undefined,
        },
        web_search: {
          ...config.tools?.web_search,
          provider: searchProvider || undefined,
          api_key: searchApiKey || undefined,
          perplexity_api_key: perplexityKey || undefined,
        },
        tts: {
          ...config.tools?.tts,
          provider: ttsProvider || undefined,
          voice: ttsVoice || undefined,
        },
      },
    });
  };

  return (
    <SectionCard id="integrations" title="Integrations" description="External services and tool API keys." onSave={handleSave}>
      {/* MS-Todo */}
      <details className="settings-collapsible" open={msTodoEnabled}>
        <summary className="settings-collapsible-title">MS To-Do</summary>
        <div className="settings-collapsible-body">
          <div className="form-group">
            <ToggleSwitch id="mstodo-enabled" checked={msTodoEnabled} onChange={setMsTodoEnabled} label="Enabled" />
          </div>
          {msTodoEnabled && (
            <div className="form-group">
              <label htmlFor="mstodo-client">Client ID</label>
              <input
                id="mstodo-client"
                type="text"
                value={msTodoClientId}
                onChange={(e) => setMsTodoClientId(e.target.value)}
                placeholder="Azure AD application client ID"
              />
            </div>
          )}
        </div>
      </details>

      {/* Slack */}
      <details className="settings-collapsible">
        <summary className="settings-collapsible-title">Slack</summary>
        <div className="settings-collapsible-body">
          <div className="form-group">
            <label htmlFor="slack-token">Bot Token</label>
            <SecretInput
              id="slack-token"
              value={slackToken}
              onChange={setSlackToken}
              placeholder="xoxb-..."
            />
          </div>
          <div className="form-group">
            <label htmlFor="slack-channel">Default Channel</label>
            <input
              id="slack-channel"
              type="text"
              value={slackChannel}
              onChange={(e) => setSlackChannel(e.target.value)}
              placeholder="#general"
            />
          </div>
        </div>
      </details>

      {/* Web Search */}
      <details className="settings-collapsible">
        <summary className="settings-collapsible-title">Web Search</summary>
        <div className="settings-collapsible-body">
          <div className="form-group">
            <label htmlFor="ws-provider">Provider</label>
            <select id="ws-provider" value={searchProvider} onChange={(e) => setSearchProvider(e.target.value)}>
              <option value="">Default</option>
              <option value="tavily">Tavily</option>
              <option value="perplexity">Perplexity</option>
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="ws-apikey">API Key</label>
            <SecretInput id="ws-apikey" value={searchApiKey} onChange={setSearchApiKey} placeholder="Tavily API key" />
          </div>
          <div className="form-group">
            <label htmlFor="ws-perplexity">Perplexity API Key</label>
            <SecretInput id="ws-perplexity" value={perplexityKey} onChange={setPerplexityKey} placeholder="Perplexity API key" />
          </div>
        </div>
      </details>

      {/* TTS */}
      <details className="settings-collapsible">
        <summary className="settings-collapsible-title">Text-to-Speech</summary>
        <div className="settings-collapsible-body">
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="tts-provider">Provider</label>
              <input
                id="tts-provider"
                type="text"
                value={ttsProvider}
                onChange={(e) => setTtsProvider(e.target.value)}
                placeholder="e.g., say"
              />
            </div>
            <div className="form-group">
              <label htmlFor="tts-voice">Voice</label>
              <input
                id="tts-voice"
                type="text"
                value={ttsVoice}
                onChange={(e) => setTtsVoice(e.target.value)}
                placeholder="e.g., Samantha"
              />
            </div>
          </div>
        </div>
      </details>
    </SectionCard>
  );
}
