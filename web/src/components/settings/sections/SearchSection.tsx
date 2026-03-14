import { useState, useEffect } from 'react';
import type { Config } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { NumberInput } from '../inputs/NumberInput';

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

export function SearchSection({ config, onSave }: Props) {
  const search = config.search ?? {};
  const [enabled, setEnabled] = useState(search.enabled ?? true);
  const [ollamaUrl, setOllamaUrl] = useState(search.ollama_url ?? 'http://localhost:11434');
  const [model, setModel] = useState(search.model ?? 'bge-m3');
  const [defaultMode, setDefaultMode] = useState(search.default_mode ?? 'hybrid');
  const [rrfAlpha, setRrfAlpha] = useState<number | undefined>(search.rrf_alpha ?? 0.4);

  useEffect(() => {
    const s = config.search ?? {};
    setEnabled(s.enabled ?? true);
    setOllamaUrl(s.ollama_url ?? 'http://localhost:11434');
    setModel(s.model ?? 'bge-m3');
    setDefaultMode(s.default_mode ?? 'hybrid');
    setRrfAlpha(s.rrf_alpha ?? 0.4);
  }, [config]);

  const handleSave = async () => {
    await onSave({
      search: {
        ...config.search,
        enabled,
        ollama_url: ollamaUrl,
        model,
        default_mode: defaultMode as 'hybrid' | 'keyword' | 'semantic',
        rrf_alpha: rrfAlpha,
      },
    });
  };

  return (
    <SectionCard id="search" title="Search & Embedding" description="Vector search configuration (Ollama + BGE-M3)." onSave={handleSave}>
      <div className="form-group">
        <ToggleSwitch id="search-enabled" checked={enabled} onChange={setEnabled} label="Enable Embedding Search" />
      </div>

      <div className="form-group">
        <label htmlFor="ollama-url">Ollama URL</label>
        <input
          id="ollama-url"
          type="text"
          value={ollamaUrl}
          onChange={(e) => setOllamaUrl(e.target.value)}
          placeholder="http://localhost:11434"
        />
      </div>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="embed-model">Embedding Model</label>
          <input
            id="embed-model"
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="bge-m3"
          />
        </div>

        <div className="form-group">
          <label htmlFor="search-mode">Default Search Mode</label>
          <select
            id="search-mode"
            value={defaultMode}
            onChange={(e) => setDefaultMode(e.target.value)}
          >
            <option value="hybrid">Hybrid (BM25 + vector)</option>
            <option value="keyword">Keyword only</option>
            <option value="semantic">Semantic only</option>
          </select>
        </div>
      </div>

      <div className="form-group">
        <label htmlFor="rrf-alpha">RRF Alpha (BM25 weight)</label>
        <NumberInput
          id="rrf-alpha"
          value={rrfAlpha}
          onChange={setRrfAlpha}
          step={0.1}
          min={0}
          max={1}
          placeholder="0.4"
        />
        <p className="text-sm text-muted" style={{ marginTop: 2 }}>
          0 = pure vector, 1 = pure keyword. Default: 0.4.
        </p>
      </div>
    </SectionCard>
  );
}
