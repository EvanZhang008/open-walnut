import { useState, useEffect } from 'react';
import type { Config } from '@walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { ListEditor } from '../inputs/ListEditor';
import { NumberInput } from '../inputs/NumberInput';

/** Extract a human-readable label from a model ID. */
function modelDisplayName(modelId: string): string {
  const is1M = modelId.endsWith('[1m]');
  const ctx = is1M ? '1M' : '200K';
  const lower = modelId.toLowerCase();

  let name: string;
  if (lower.includes('opus') && lower.includes('4-6')) name = 'Opus 4.6';
  else if (lower.includes('opus') && lower.includes('4-')) name = 'Opus 4';
  else if (lower.includes('sonnet') && lower.includes('4-6')) name = 'Sonnet 4.6';
  else if (lower.includes('sonnet') && lower.includes('4-5')) name = 'Sonnet 4.5';
  else if (lower.includes('sonnet')) name = 'Sonnet';
  else if (lower.includes('haiku') && lower.includes('4-5')) name = 'Haiku 4.5';
  else if (lower.includes('haiku')) name = 'Haiku';
  else if (lower.includes('opus')) name = 'Opus';
  else return modelId.length > 40 ? modelId.slice(0, 37) + '...' : modelId;

  if (lower.includes('haiku')) return name;
  return `${name} (${ctx})`;
}

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

export function ModelsSection({ config, onSave }: Props) {
  // Normalize available_models to string[]
  const rawModels = config.agent?.available_models ?? [];
  const modelIds = rawModels.map((m) => (typeof m === 'string' ? m : m.id));

  const [mainModel, setMainModel] = useState(config.agent?.main_model ?? '');
  const [sessionModel, setSessionModel] = useState(config.agent?.session_model ?? 'opus');
  const [availableModels, setAvailableModels] = useState<string[]>(modelIds);
  const [maxTokens, setMaxTokens] = useState<number | undefined>(config.agent?.maxTokens);

  useEffect(() => {
    const ids = (config.agent?.available_models ?? []).map((m) => (typeof m === 'string' ? m : m.id));
    setMainModel(config.agent?.main_model ?? '');
    setSessionModel(config.agent?.session_model ?? 'opus');
    setAvailableModels(ids);
    setMaxTokens(config.agent?.maxTokens);
  }, [config]);

  const handleSave = async () => {
    await onSave({
      agent: {
        ...config.agent,
        main_model: mainModel || undefined,
        session_model: sessionModel || undefined,
        available_models: availableModels,
        maxTokens,
      },
    });
  };

  return (
    <SectionCard id="models" title="Models" description="AI model selection for the main agent and sessions." onSave={handleSave}>
      {availableModels.length > 0 && (
        <div className="form-group">
          <label htmlFor="main-model">Main AI Model</label>
          <select
            id="main-model"
            value={mainModel}
            onChange={(e) => setMainModel(e.target.value)}
          >
            <option value="">Default</option>
            {availableModels.map((id) => (
              <option key={id} value={id}>{modelDisplayName(id)}</option>
            ))}
          </select>
          <p className="text-sm text-muted" style={{ marginTop: 2 }}>
            Model used by the main AI agent for chat and task processing.
          </p>
        </div>
      )}

      <div className="form-group">
        <label htmlFor="session-model">Session Model</label>
        <select
          id="session-model"
          value={sessionModel}
          onChange={(e) => setSessionModel(e.target.value)}
        >
          <option value="opus">Opus</option>
          <option value="sonnet">Sonnet</option>
          <option value="haiku">Haiku</option>
        </select>
        <p className="text-sm text-muted" style={{ marginTop: 2 }}>
          Default model for Claude Code sessions (--model flag).
        </p>
      </div>

      <div className="form-group">
        <label>Available Models</label>
        <p className="text-sm text-muted" style={{ margin: '-4px 0 4px' }}>
          Model IDs shown in selection dropdowns.
        </p>
        <ListEditor
          items={availableModels}
          onChange={setAvailableModels}
          placeholder="Add model ID..."
          vertical
        />
      </div>

      <div className="form-group">
        <label htmlFor="max-tokens">Max Output Tokens</label>
        <NumberInput
          id="max-tokens"
          value={maxTokens}
          onChange={setMaxTokens}
          suffix="tokens"
          placeholder="16384"
          min={1}
        />
      </div>
    </SectionCard>
  );
}
