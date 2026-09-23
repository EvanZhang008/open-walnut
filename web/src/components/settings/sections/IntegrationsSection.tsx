import type { ChangeEvent } from 'react';
import type { Config } from '@open-walnut/core';
import { SettingsDisclosure, SettingsGroup, SettingsRow, SettingsSection } from '../SettingsSection';
import { SecretInput } from '../inputs/SecretInput';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { useCommitField } from '../inputs/useCommitField';
import { useSerialSave, type OnSave } from './GeneralSection';

interface Props {
  config: Config;
  onSave: OnSave;
}

type Tools = NonNullable<Config['tools']>;
type SearchProvider = 'tavily' | 'brave' | 'perplexity';

/**
 * A SecretInput that commits on blur through useCommitField (same Saved /
 * row error / flush-on-unmount rules as a text row).
 */
function useSecretField(serverValue: string, commit: (v: string) => Promise<unknown>, rowKey: string) {
  const field = useCommitField<string>(serverValue, commit, { rowKey, kind: 'text' });
  return {
    value: field.inputProps.value,
    onChange: (v: string) => field.inputProps.onChange({ target: { value: v } } as ChangeEvent<HTMLInputElement>),
    onBlur: () => field.inputProps.onBlur(),
    error: field.error,
  };
}

/**
 * Keys for the agent's own tools (Slack bot, web search). Plugins are enabled
 * and configured only on their row in Plugins, so nothing here has an Enabled
 * switch: these config keys have no enabled field.
 */
export function IntegrationsSection({ config, onSave }: Props) {
  const save = useSerialSave(config, onSave);
  const saveTools = (patch: (tools: Tools | undefined) => Partial<Tools>, rowKey: string) =>
    save((c) => ({ tools: { ...c.tools, ...patch(c.tools) } as Tools }), { rowKey });
  const slack = config.tools?.slack;
  const search = config.tools?.web_search;

  const slackToken = useSecretField(
    slack?.bot_token ?? '',
    (v) => saveTools((t) => ({ slack: { ...t?.slack, bot_token: v || undefined } }), 'integrations.slack-token'),
    'integrations.slack-token',
  );
  const slackChannel = useCommitField<string>(
    slack?.default_channel ?? '',
    (v) => saveTools((t) => ({ slack: { ...t?.slack, default_channel: v.trim() || undefined } }), 'integrations.slack-channel'),
    { rowKey: 'integrations.slack-channel', kind: 'text' },
  );
  const provider = useOptimisticSetting<SearchProvider>(
    (search?.provider as SearchProvider | undefined) || 'tavily',
    (v) => saveTools((t) => ({ web_search: { ...t?.web_search, provider: v } }), 'integrations.search-provider'),
    { rowKey: 'integrations.search-provider' },
  );
  const searchKey = useSecretField(
    search?.api_key ?? '',
    (v) => saveTools((t) => ({ web_search: { ...t?.web_search, api_key: v || undefined } }), 'integrations.search-key'),
    'integrations.search-key',
  );
  const perplexityKey = useSecretField(
    search?.perplexity_api_key ?? '',
    (v) => saveTools((t) => ({ web_search: { ...t?.web_search, perplexity_api_key: v || undefined } }), 'integrations.perplexity-key'),
    'integrations.perplexity-key',
  );
  const hasSearchKey = provider.value === 'perplexity' ? !!search?.perplexity_api_key : !!search?.api_key;

  return (
    <SettingsSection id="integrations" title="Integrations" description="Keys for the agent's own tools.">
      <SettingsGroup>
        <SettingsDisclosure
          id="integrations-slack"
          data-testid="integrations-slack"
          label="Slack bot for the agent"
          summary={slack?.bot_token ? 'Token saved' : 'No token'}
        >
          <SettingsRow indent label="Bot token" htmlFor="slack-token" error={slackToken.error} control={
            <SecretInput id="slack-token" value={slackToken.value} onChange={slackToken.onChange} onBlur={slackToken.onBlur} placeholder="xoxb-..." />
          } />
          <SettingsRow indent label="Default channel" htmlFor="slack-channel" error={slackChannel.error} control={
            <input id="slack-channel" type="text" className="settings-input settings-input--short" placeholder="#general" {...slackChannel.inputProps} />
          } />
        </SettingsDisclosure>
        <SettingsDisclosure
          id="integrations-web-search"
          data-testid="integrations-web-search"
          label="Web search"
          summary={hasSearchKey ? 'Key saved' : 'No key'}
        >
          <SettingsRow indent label="Provider" error={provider.error} control={
            <SegmentedControl<SearchProvider>
              id="ws-provider"
              aria-label="Web search provider"
              value={provider.value}
              onChange={provider.set}
              options={[
                { value: 'tavily', label: 'Tavily', testId: 'ws-provider-tavily' },
                { value: 'brave', label: 'Brave', testId: 'ws-provider-brave' },
                { value: 'perplexity', label: 'Perplexity', testId: 'ws-provider-perplexity' },
              ]}
            />
          } />
          {provider.value !== 'perplexity' ? (
            <SettingsRow indent label="API key" htmlFor="ws-apikey" error={searchKey.error} control={
              <SecretInput id="ws-apikey" value={searchKey.value} onChange={searchKey.onChange} onBlur={searchKey.onBlur}
                placeholder={provider.value === 'brave' ? 'BSAxxxxxxxx' : 'tvly-xxxxxxxx'} />
            } />
          ) : (
            <SettingsRow indent label="Perplexity API key" htmlFor="ws-perplexity" error={perplexityKey.error} control={
              <SecretInput id="ws-perplexity" value={perplexityKey.value} onChange={perplexityKey.onChange} onBlur={perplexityKey.onBlur}
                placeholder="pplx-xxxxxxxx" />
            } />
          )}
        </SettingsDisclosure>
      </SettingsGroup>
      {/* Text-to-Speech lives in Voice next to dictation, not here. */}
    </SettingsSection>
  );
}
